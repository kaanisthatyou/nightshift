// Bulk-load provider API keys into OmniRoute.
//
//   node tools/import-keys.mjs [keysFile] [--dry-run] [--no-test]
//
// The catalog (which provider ids exist, and their default base URLs) is read
// live from the running OmniRoute, never guessed here. Keys are never printed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const BASE = process.env.OMNIROUTE_URL_ROOT || "http://localhost:20128";
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const NO_TEST = args.includes("--no-test");
const FILE = args.find((a) => !a.startsWith("--")) || path.join(os.homedir(), ".omniroute", "keys.txt");

const mask = (k) => (k.length <= 8 ? "•".repeat(k.length) : `${k.slice(0, 3)}…${k.slice(-4)}`);
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

// ---- the keys file ---------------------------------------------------

/**
 * One key per line. Whatever you naturally type should work:
 *   openai = sk-...
 *   groq: gsk_...
 *   mistral  sk-...            (single space also fine)
 *   openai = sk-... | second account | https://api.openai.com/v1
 * # and // start a comment. Blank lines ignored.
 */
export function parseKeys(text) {
  const out = [];
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;

    const [head, ...rest] = line.split("|").map((s) => s.trim());
    const m = head.match(/^([A-Za-z0-9 ._-]+?)\s*[=:\t ]\s*(\S.*)$/);
    if (!m) {
      problems.push({ line: i + 1, text: line.slice(0, 40), why: "could not split provider from key" });
      return;
    }
    const [, who, key] = m;
    if (key.length < 8) {
      problems.push({ line: i + 1, text: who, why: "key looks too short" });
      return;
    }
    out.push({
      line: i + 1,
      who: who.trim(),
      key: key.trim(),
      name: rest[0] || undefined,
      url: rest.find((r) => /^https?:\/\//i.test(r)),
    });
  });
  return { keys: out, problems };
}

// ---- talking to omniroute -------------------------------------------

async function ask(question, muted = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (muted) {
    const onData = (char) => {
      if (["\n", "\r", "\u0004"].includes(String(char))) return;
      readline.moveCursor(process.stdout, -1, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write("*");
    };
    process.stdin.on("data", onData);
    const answer = await new Promise((r) => rl.question(question, r));
    process.stdin.off("data", onData);
    rl.close();
    process.stdout.write("\n");
    return answer;
  }
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer;
}

async function login(password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403 && body?.needsSetup) {
    throw new Error("this OmniRoute has no password yet - open http://localhost:20128 and finish onboarding first");
  }
  if (!res.ok) throw new Error(`login failed (${res.status}): ${body?.error?.message ?? body?.error ?? res.statusText}`);

  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  const token = body?.token ?? body?.accessToken ?? null;
  if (!cookie && !token) throw new Error("logged in but got no session cookie or token back");
  return { cookie, token };
}

function authHeaders(session) {
  const h = { "Content-Type": "application/json" };
  if (session.cookie) h.Cookie = session.cookie;
  if (session.token) h.Authorization = `Bearer ${session.token}`;
  return h;
}

async function api(session, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders(session), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

/** Pull whatever list of provider definitions this build exposes. */
function catalogFrom(body) {
  const buckets = [body?.providers, body?.catalog, body?.data, body?.connections, body];
  for (const b of buckets) {
    if (Array.isArray(b) && b.length && (b[0]?.id || b[0]?.provider)) return b;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const vals = Object.values(b);
      if (vals.length && typeof vals[0] === "object" && (vals[0]?.id || vals[0]?.name)) return vals;
    }
  }
  return [];
}

const urlOf = (entry) => entry?.baseUrl || entry?.url || entry?.defaultBaseUrl || entry?.apiBase || null;

// ---- main ------------------------------------------------------------

async function main() {
  if (!fs.existsSync(FILE)) {
    console.log(`no keys file at ${FILE}`);
    console.log(`write one (see keys.example.txt) or pass a path: node tools/import-keys.mjs C:\\path\\to\\keys.txt`);
    process.exit(1);
  }

  const { keys, problems } = parseKeys(fs.readFileSync(FILE, "utf8"));
  console.log(`\n  ${FILE}`);
  console.log(`  ${keys.length} keys parsed${problems.length ? `, ${problems.length} lines skipped` : ""}\n`);
  for (const p of problems) console.log(`  ! line ${p.line}: ${p.why} — "${p.text}"`);
  if (!keys.length) process.exit(1);

  if (DRY) {
    console.log("  dry run — nothing will be sent\n");
    for (const k of keys) console.log(`  ${pad(k.who, 22)} ${mask(k.key)}${k.url ? `  ${k.url}` : ""}`);
    return;
  }

  const password = process.env.OMNIROUTE_PASSWORD || (await ask("  omniroute dashboard password: ", true));
  const session = await login(password.trim());
  console.log("  logged in.\n");

  const cat = await api(session, "/api/providers/client");
  const catalog = cat.ok ? catalogFrom(cat.body) : [];
  const byId = new Map();
  for (const e of catalog) {
    const id = String(e.id ?? e.provider ?? "").toLowerCase();
    if (id) byId.set(id, e);
    if (e.alias) byId.set(String(e.alias).toLowerCase(), e);
    if (e.name) byId.set(String(e.name).toLowerCase(), e);
  }
  console.log(`  catalog: ${byId.size ? `${catalog.length} providers known` : "not exposed by this build - urls must come from your file"}\n`);

  const existing = await api(session, "/api/providers");
  const already = new Map(
    (existing.ok ? (existing.body?.connections ?? []) : []).map((c) => [String(c.provider).toLowerCase(), c]),
  );

  const results = [];
  for (const k of keys) {
    const want = k.who.toLowerCase();
    const entry = byId.get(want);
    const provider = String(entry?.id ?? entry?.provider ?? want);
    const url = k.url ?? urlOf(entry);

    if (!url) {
      results.push({ who: k.who, state: "no url", note: "add ` | https://…` to that line" });
      continue;
    }

    const payload = {
      provider,
      name: k.name ?? entry?.name ?? provider,
      url,
      apiKey: k.key,
      isActive: true,
    };
    const prev = already.get(provider.toLowerCase());
    const res = prev
      ? await api(session, `/api/providers/${prev.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api(session, "/api/providers", { method: "POST", body: JSON.stringify(payload) });

    if (!res.ok) {
      results.push({ who: k.who, state: `http ${res.status}`, note: String(res.body?.error?.message ?? res.body?.error ?? "").slice(0, 60) });
      continue;
    }
    const id = res.body?.id ?? res.body?.connection?.id ?? prev?.id;
    results.push({ who: k.who, state: prev ? "updated" : "added", id, provider });
  }

  if (!NO_TEST) {
    console.log("  testing each key against its provider...\n");
    for (const r of results) {
      if (!r.id) continue;
      const t = await api(session, `/api/providers/${r.id}/test`, { method: "POST", body: "{}" });
      const ok = t.ok && (t.body?.ok ?? t.body?.success ?? true);
      r.test = ok ? "works" : `failed: ${String(t.body?.error?.message ?? t.body?.error ?? t.status).slice(0, 40)}`;
    }
  }

  console.log(`  ${pad("provider", 22)}${pad("import", 12)}test`);
  console.log(`  ${"-".repeat(60)}`);
  for (const r of results) console.log(`  ${pad(r.who, 22)}${pad(r.state, 12)}${r.test ?? r.note ?? ""}`);

  const good = results.filter((r) => r.test === "works").length;
  const inPlace = results.filter((r) => r.state === "added" || r.state === "updated").length;
  console.log(`\n  ${inPlace}/${results.length} in place${NO_TEST ? "" : `, ${good} answering`}`);
  console.log("  the floor picks new models up within 15 seconds.\n");
}

main().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
