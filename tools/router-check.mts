// The router, exercised against fake providers on localhost - no keys, no network.
// What has to hold: a key that says 429 hands the request to the next key; a
// provider whose every key is resting hands the same conversation to the next
// model on the route; a silent lane is abandoned; tool call ids survive a move
// between providers; and a file a desk writes is parsed on the spot.
//
//   npx tsx tools/router-check.mts
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.NIGHTSHIFT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "nightshift-router-"));
const { ModelRouter, RateLimited } = await import("../server/router.ts");
const { syntaxCheck, checkCommand, layoutHints, looseReplace } = await import("../server/workspace.ts");

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`);
};

interface Seen { key: string; model: string; body: any }

/** A tiny OpenAI-compatible server. `behave` decides, per key, what happens. */
function fake(behave: (key: string, body: any) => "ok" | "429" | "silent" | "401") {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m-a" }, { id: "m-b" }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ key, model: body.model, body });
      const what = behave(key, body);
      if (what === "429") {
        res.writeHead(429, { "retry-after": "100" });
        res.end("too many requests");
        return;
      }
      if (what === "401") {
        res.writeHead(401);
        res.end("bad key");
        return;
      }
      if (what === "silent") return; // never answers
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `served by ${key} on ${body.model}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ url: string; seen: Seen[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, seen, close: () => server.close() });
    }),
  );
}

const convo = [
  { role: "system", content: "you are a desk" },
  { role: "user", content: "write a file" },
  { role: "assistant", content: null, tool_calls: [{ id: "9b73f5fb-4fba-438c-823f-5aa1", type: "function", function: { name: "write_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "9b73f5fb-4fba-438c-823f-5aa1", content: "created" },
];

// ---- a resting key hands over to the next key ---------------------------
{
  const p = await fake((key) => (key === "k1" ? "429" : "ok"));
  const r = new ModelRouter();
  r.upsertProvider({ id: "alpha", baseUrl: p.url, keys: ["k1", "k2"], rpm: 0, concurrency: 2 });
  await r.refresh();
  const res = await r.chat({ model: "alpha/m-a", messages: convo });
  check("a 429 on one key is served by the other", res.text.includes("served by k2"), res.text);
  check("the decision names the lane that served it", res.decision === "alpha#2 m-a", String(res.decision));
  const lane1 = r.snapshot().providers[0].lanes[0];
  check("the refused key is resting", lane1.coolUntil > Date.now(), JSON.stringify(lane1));
  const moved = p.seen.find((s) => s.key === "k2")!.body.messages;
  const ids = [moved[2].tool_calls[0].id, moved[3].tool_call_id];
  check("tool call ids are made portable", /^[a-zA-Z0-9]{9}$/.test(ids[0]) && ids[0] === ids[1], ids.join(" / "));
  p.close();
}

// ---- a provider out of quota hands the conversation to the next model -----
{
  const a = await fake(() => "429");
  const b = await fake(() => "ok");
  const r = new ModelRouter();
  r.upsertProvider({ id: "slow", baseUrl: a.url, keys: ["s1", "s2"], rpm: 0, concurrency: 2 });
  r.upsertProvider({ id: "fast", baseUrl: b.url, keys: ["f1"], rpm: 0, concurrency: 2 });
  await r.refresh();
  r.setRoute({ id: "pool", models: ["slow/m-a", "fast/m-b"] });
  const hops: string[] = [];
  const res = await r.chat({ model: "route:pool", messages: convo, onHop: (from, to) => hops.push(`${from} > ${to}`) });
  check("the route moves on when every key of the first model rests", res.decision === "fast#1 m-b", String(res.decision));
  check("the whole conversation arrives at the next provider", b.seen[0]?.body.messages.length === convo.length);
  check("the hop is reported", hops.length >= 1, hops.join(", "));

  // a desk pinned to one model still spills onto auto when that model is out
  r.setRoute({ id: "auto", models: ["fast/m-b"] });
  const pinned = await r.chat({ model: "slow/m-a", prompt: "hi" });
  check("a pinned model spills onto the auto route", pinned.decision === "fast#1 m-b", String(pinned.decision));

  r.fallback = false;
  let waitedFor = 0;
  let failed: unknown = null;
  try {
    await r.chat({ model: "slow/m-a", prompt: "hi", signal: AbortSignal.timeout(1500), onWait: (ms) => (waitedFor = ms) });
  } catch (err) {
    failed = err;
  }
  check("with nowhere to go it waits for the soonest key, keeping the conversation", waitedFor > 50_000, `${waitedFor}ms`);
  check("and only the caller's own deadline ends the wait", !(failed instanceof RateLimited) && Boolean(failed), String(failed));
  a.close();
  b.close();
}

// ---- a lane that goes silent is abandoned ---------------------------------
{
  const hang = await fake(() => "silent");
  const ok = await fake(() => "ok");
  const r = new ModelRouter();
  r.upsertProvider({ id: "hang", baseUrl: hang.url, keys: ["h1"], rpm: 0 });
  r.upsertProvider({ id: "ok", baseUrl: ok.url, keys: ["o1"], rpm: 0 });
  await r.refresh();
  r.setRoute({ id: "pool", models: ["hang/m-a", "ok/m-a"] });
  const started = Date.now();
  const res = await r.chat({ model: "route:pool", prompt: "hi", idleMs: 400 });
  check("a silent lane is dropped after its idle limit", res.decision === "ok#1 m-a" && Date.now() - started < 5000, `${res.decision} in ${Date.now() - started}ms`);
  hang.close();
  ok.close();
}

// ---- keys pasted by the handful ------------------------------------------
{
  const r = new ModelRouter();
  const out = r.importKeys("nvapi-aaaaaaaaaaaaaaaaaaaa\ngsk_bbbbbbbbbbbbbbbbbbbb\n# a comment\nmistral = cccccccccccc\nnonsense");
  const got = out.added.map((a) => `${a.provider}:${a.count}`).sort().join(",");
  check("keys are matched to providers by prefix or by name", got === "groq:1,mistral:1,nim:1", got);
  check("a line that is not a key is counted, not guessed", out.skipped === 1, String(out.skipped));
  check("the window never sees a key", !JSON.stringify(r.snapshot()).includes("nvapi-aaaa"));
}

// ---- a desk hears about a broken file the moment it writes it --------------
{
  const broken = await syntaxCheck("src/Hero.tsx", "export function Hero() { return <div><span></div>; }");
  check("an unclosed JSX tag is reported on write", Boolean(broken && broken.includes("Hero.tsx:1")), String(broken));
  const fine = await syntaxCheck("src/Hero.tsx", "export function Hero() { return <div><span /></div>; }");
  check("a clean file says nothing", fine === null, String(fine));
  check("bad JSON is reported", Boolean(await syntaxCheck("package.json", '{"a":1,}')));
  check("a dev server is refused - it would never exit", !checkCommand("npm run dev").ok);
  check("a build is not", checkCommand("npm run build").ok);
  check(
    "an absolute child with no relative parent is flagged",
    Boolean(layoutHints("src/V.tsx", '<div className="p-4"><span className="absolute -top-6" /></div>')),
  );
  const src = "function A() {\n  return (\n    <div>\n      <b>x</b>\n    </div>\n  );\n}";
  const loose = looseReplace(src, "  <div>\n        <b>x</b>\n  </div>", "    <section />");
  check("an edit with the indentation off still lands, once", loose.count === 1 && loose.text.includes("<section />") && !loose.text.includes("<b>"), JSON.stringify(loose));
  check(
    "a contained one is not",
    layoutHints("src/V.tsx", '<div className="relative p-4"><span className="absolute -top-6" /></div>') === null,
  );
}

console.log(bad ? `\n${bad} failed\n` : "\nall good\n");
process.exit(bad ? 1 : 0);
