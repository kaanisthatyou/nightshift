// The shift itself: who works on what, when, and what it costs.
import fs from "node:fs";
import path from "node:path";
import { ModelRouter, RateLimited } from "./router.ts";
import { asOpenAiTools, mcp } from "./mcp.ts";
import { NATIVE_NAMES, asOpenAiNative, deskCheck, nativeTools, runNative, shell, verify } from "./workspace.ts";
import { store } from "./store.ts";
import { CUT_OFF_NOTE, buildBriefing, repairNote } from "./brief.ts";
import { stack } from "./templates.ts";
import {
  ACCEPT_LINES, COFFEE_LINE, DONE_LINES, FAIL_LINES, GHOST_NOTE, IDLE_LINES, fallbackLine, pick,
} from "./flavor.ts";
import { HOUSE_RULES } from "../shared/presets.ts";
import type { ChatResult } from "./router.ts";
import type { Plan, Task, ToolCall, Worker } from "../shared/types.ts";

/**
 * Every model the floor can reach, behind one object. It is still called the
 * gateway in the rest of the code because that is the job it does - but there is
 * no gateway process any more: the floor talks to each provider itself.
 */
export const gateway = new ModelRouter();

/**
 * Tasks the boss just walked over to: hold them until the walk animation lands.
 * A rate-limited task parks in the same map, for as long as the provider said.
 */
const holdUntil = new Map<string, number>();
export const THEATRE_MS = 2200;

/** After this many waits in a row it is not a busy minute, it is a wall. */
const RATE_WAIT_LIMIT = 6;

const running = new Set<string>();

function idleWorkers(): Worker[] {
  return store.state.workers.filter((w) => w.state === "idle" && !w.currentTaskId);
}

function resolvePrompt(t: Task, prev: string): string {
  let p = t.prompt;
  if (p.includes("{{input}}") || p.includes("{{prev}}")) {
    p = p.replaceAll("{{input}}", prev).replaceAll("{{prev}}", prev);
  } else if (prev) {
    p = `${p}\n\n--- INPUT FROM THE PREVIOUS DESK ---\n${prev}`;
  }
  if (t.reviewNote) {
    p = `${p}\n\n--- THE BOSS SENT THIS BACK ---\n${t.reviewNote}\nFix it. Return the corrected work only.`;
  }
  return p;
}

function previousOutput(t: Task): string {
  // In a workspace the previous desk handed its work over as files, not as
  // text. Stapling its summary onto this prompt would just be noise - the
  // desk can read what actually landed.
  if (t.workspace) return "";
  if (!t.jobId || t.stepIndex === 0) return "";
  const job = store.job(t.jobId);
  if (!job || job.kind !== "pipeline") return "";
  const prevId = job.taskIds[t.stepIndex - 1];
  return store.task(prevId)?.output ?? "";
}

async function ghostRun(t: Task, onChunk: (s: string) => void) {
  const body =
    `${GHOST_NOTE}\n\n` +
    `> is: ${t.title}\n> prompt: ${(t.sentPrompt ?? t.prompt).slice(0, 220)}\n\n` +
    `[simulasyon] masa buraya cevap yazacakti.`;
  for (const chunk of body.match(/.{1,14}/gs) ?? []) {
    onChunk(chunk);
    await new Promise((r) => setTimeout(r, 45));
  }
  return body;
}

/** Tool results can be enormous. A desk gets the useful head of one, not all of it. */
const TOOL_RESULT_CAP = 12_000;

/**
 * What is kept on the task afterwards. The model needs the whole result to work
 * with; the window only needs enough to show what happened, and the whole floor
 * state travels over the socket on every single change.
 */
const TOOL_RECORD_CAP = 700;

/**
 * Which tools this desk may actually reach right now. A desk that named
 * specific tools gets only those - handing a cheap model twenty-six schemas is
 * how you get it to pick the wrong one.
 */
function deskTools(w: Worker) {
  if (!store.state.settings.mcpEnabled) return [];
  const all = mcp.toolsFor(w.mcpIds ?? []);
  const picked = w.mcpTools ?? [];
  if (!picked.length) return all;
  return all.filter((t) => picked.includes(t.qualified) || picked.includes(t.name));
}

/** Which native tools are on the desk, given the master switches. */
function floorTools(t: Task) {
  if (!t.workspace) return [];
  return nativeTools(store.state.settings.shellEnabled !== false);
}

/**
 * The type check a desk runs over its own files when it says it is done: the
 * stack's own, or tsc when the folder is a TypeScript project with it installed.
 */
function checkFor(t: Task): string | null {
  if (!t.workspace) return null;
  const plan = t.planId ? store.plan(t.planId) : undefined;
  const s = stack(plan?.stack ?? null);
  if (s?.typecheck) return s.typecheck;
  if (s && !s.typecheck) return null;
  const ts = fs.existsSync(path.join(t.workspace, "tsconfig.json")) &&
    fs.existsSync(path.join(t.workspace, "node_modules", "typescript"));
  return ts ? "npx tsc --noEmit -p ." : null;
}

/** Files every other task on the same job owns - so a desk's check can tell "missing" from "coming". */
function teammatesClaims(t: Task): string[] {
  if (!t.jobId) return [];
  const job = store.job(t.jobId);
  if (!job) return [];
  return job.taskIds
    .filter((id) => id !== t.id)
    .flatMap((id) => store.task(id)?.claims ?? [])
    .filter((c) => c !== "**");
}

/**
 * Old rounds of a long conversation are mostly bulk the model has already acted
 * on: whole files it wrote, whole files it read. Every one of those is re-sent,
 * re-read and paid for on every round after - and on a provider doing fifteen
 * tokens a second, a prompt that doubles is a desk that halves. Anything older
 * than the last few messages is cut down to what it was, not what it said. The
 * files are on disk; a desk that needs one again reads it again.
 */
function compact(messages: any[], keepTail = 6) {
  const cut = messages.length - keepTail;
  for (let i = 0; i < cut; i++) {
    const m = messages[i];
    if (m._compact) continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const raw = call.function?.arguments;
        if (typeof raw !== "string" || raw.length < 600) continue;
        try {
          const args = JSON.parse(raw);
          for (const key of ["content", "find", "replace"]) {
            if (typeof args[key] === "string" && args[key].length > 300) {
              const lines = args[key].split("\n").length;
              args[key] = `[${lines} lines - already applied to disk; read_file to see the current file]`;
            }
          }
          call.function.arguments = JSON.stringify(args);
        } catch {
          call.function.arguments = "{}";
        }
      }
      m._compact = true;
    } else if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) {
      m.content = `${m.content.slice(0, 500)}\n...[older output trimmed - run the tool again if you need it]`;
      m._compact = true;
    }
  }
}

/** The wire must not carry our bookkeeping. */
const wire = (messages: any[]) =>
  messages.map((m) => {
    if (!("_compact" in m)) return m;
    const { _compact, ...rest } = m;
    return rest;
  });

/**
 * The tool loop. Runs the model, executes whatever it asked for, feeds the
 * results back, and repeats until it answers in words or burns its rounds.
 * With no tools on the desk this is a single pass.
 *
 * Every round is a separate request, and the router is free to serve each one
 * from a different key or provider - the conversation is the state, not the
 * connection. In build mode, a desk that says it is finished gets its own files
 * type-checked, and what fails goes straight back into the same conversation.
 */
async function converse(
  t: Task,
  w: Worker,
  model: string,
  system: string | null,
  onChunk: (s: string) => void,
): Promise<ChatResult> {
  const build = Boolean(t.workspace);
  const native = floorTools(t);
  const tools = deskTools(w);
  const defs = [...asOpenAiNative(native), ...asOpenAiTools(tools)];
  const check = build ? checkFor(t) : null;
  const messages: any[] = [];
  const persona = build ? [system, buildBriefing(t, check)].filter(Boolean).join("\n\n") : system;
  if (persona) messages.push({ role: "system", content: persona });
  messages.push({ role: "user", content: t.sentPrompt ?? t.prompt });

  const s = store.state.settings;
  const maxRounds = build ? Math.max(6, s.buildMaxRounds || 30) : Math.max(1, s.mcpMaxRounds || 6);
  let repairsLeft = build ? Math.max(0, s.repairRounds ?? 2) : 0;
  const reasoning = w.reasoning ?? s.reasoning ?? "low";

  let last: ChatResult | null = null;
  let summary = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  const lanes = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    const left = maxRounds - round - 1;
    // A text task loses its tools on the last round so it has to answer in
    // words. A build task keeps them: an unfinished build should say it is
    // unfinished, not narrate the code it never wrote.
    const offerTools = defs.length > 0 && (build || left > 0);
    if (build) compact(messages);
    const res = await gateway.chat({
      model,
      messages: wire(messages),
      maxTokens: build ? 12_000 : 2_400,
      temperature: build ? 0.3 : 0.5,
      reasoning,
      // a provider that buffers a whole tool call sends nothing until it is done;
      // a 10k-token file at fifteen tokens a second is eleven silent minutes
      idleMs: build ? 12 * 60_000 : 4 * 60_000,
      signal: AbortSignal.timeout(build ? 20 * 60_000 : 8 * 60_000),
      onChunk,
      onWait: (ms) => {
        const secs = Math.ceil(ms / 1000);
        if (w.state !== "coffee") {
          store.setWorkerState(w.id, "coffee", `${secs}sn - butun anahtarlar dolu, bekliyorum`);
          store.emitEvent({
            type: "system", taskId: t.id, workerId: w.id,
            text: `${model}: every key is resting - waiting ${secs}s, work kept`,
            data: { rateLimited: true, waitMs: ms, model },
          });
        }
      },
      onHop: (from, to, why) => {
        store.emitEvent({
          type: "provider",
          workerId: w.id,
          taskId: t.id,
          text: `${from} -> ${to}`,
          data: { from, to, why: why.slice(0, 200) },
        });
      },
      ...(offerTools ? { tools: defs } : {}),
    });
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;
    if (res.costUsd != null) costUsd += res.costUsd;
    if (res.decision) {
      lanes.add(res.decision);
      t.decision = res.decision;
      t.hops = lanes.size - 1;
    }
    last = res;

    let finished = !res.toolCalls.length;

    if (res.toolCalls.length) {
      messages.push({
        role: "assistant",
        content: res.text || null,
        tool_calls: res.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        })),
      });

      // file writes are independent of each other; running them together is
      // the same work in less wall time, and a desk that sends five files at
      // once should not wait on them one by one
      // - but a command or a finish has to see those files, so those go after, in order
      const PARALLEL = new Set(["write_file", "read_file", "list_files", "search_files"]);
      const records: ToolCall[] = new Array(res.toolCalls.length);
      await Promise.all(
        res.toolCalls.map(async (call, i) => {
          if (PARALLEL.has(call.name)) records[i] = await invoke(t, w, call.name, call.arguments, res.finishReason);
        }),
      );
      for (let i = 0; i < res.toolCalls.length; i++) {
        const call = res.toolCalls[i];
        if (!records[i]) records[i] = await invoke(t, w, call.name, call.arguments, res.finishReason);
      }
      res.toolCalls.forEach((call, i) => {
        const record = records[i];
        if (call.name === "finish" && record.ok) {
          finished = true;
          summary = record.result;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: record.result });
      });
      store.setWorkerState(w.id, "thinking", null);
    } else if (build && res.finishReason === "length") {
      messages.push({ role: "assistant", content: res.text || "(cut off)" });
      messages.push({ role: "user", content: CUT_OFF_NOTE });
      continue;
    } else if (build && !t.files.length && left > 0) {
      // a build desk that answered in prose has not started yet - say so once more
      messages.push({ role: "assistant", content: res.text || "" });
      messages.push({
        role: "user",
        content: "Nothing has been written to disk. Code in a reply is discarded - use write_file for every file you own, then call finish.",
      });
      continue;
    }

    if (!finished) {
      const tail = messages.at(-1);
      if (build && left <= 3 && left > 0 && tail && typeof tail.content === "string") {
        tail.content +=
          `\n\n[floor] ${left} ${left === 1 ? "round" : "rounds"} left on this task. ` +
          "Finish the file you are on, then call finish.";
      }
      continue;
    }

    // The desk says it is done. In build mode that claim gets checked.
    if (build && check && repairsLeft > 0 && t.files.length) {
      store.setWorkerState(w.id, "thinking", "kontrol ediyorum...");
      const verdict = await deskCheck(t, check, teammatesClaims(t));
      t.verifyRuns.push({
        command: check,
        ok: verdict.ok,
        code: verdict.ok ? 0 : 1,
        output: verdict.report.slice(0, 3000) || "no errors in this desk's files",
        ms: 0,
      });
      if (t.verifyRuns.length > 3) t.verifyRuns.splice(0, t.verifyRuns.length - 3);
      store.emitEvent({
        type: "verify", workerId: w.id, taskId: t.id,
        text: `${w.name}: ${verdict.ok ? "tip kontrolu temiz" : "tip hatasi var"}`,
        data: { ok: verdict.ok, command: check, preview: verdict.report.slice(0, 300) },
      });
      if (!verdict.ok) {
        repairsLeft -= 1;
        messages.push({ role: "user", content: repairNote(verdict.report) });
        store.emitEvent({ type: "worker.say", workerId: w.id, taskId: t.id, text: "tip hatasi, duzeltiyorum." });
        continue;
      }
    }

    // a task that carries its own check (a single order, a fixer) has to leave it passing
    if (build && t.verify && repairsLeft > 0) {
      store.setWorkerState(w.id, "thinking", "kontrol ediyorum...");
      const v = await verify(t, w);
      if (v && !v.ok) {
        repairsLeft -= 1;
        messages.push({
          role: "user",
          content:
            `The check failed. This is not done yet.\n\n$ ${v.command}\n${v.output}\n\n` +
            "Read the files involved, fix the actual cause, and run the check again. Do not call finish until it passes.",
        });
        store.emitEvent({ type: "worker.say", workerId: w.id, taskId: t.id, text: "check patladi, duzeltiyorum." });
        continue;
      }
    }
    break;
  }

  if (build && !t.files.length) {
    throw new Error("the desk answered in prose without writing a single file - nothing landed in the working folder");
  }

  if (build && t.verify) {
    const seen = t.verifyRuns.filter((v) => v.command === t.verify).at(-1) ?? (await verify(t, w));
    if (seen && !seen.ok) {
      throw new Error(`the check never passed: ${seen.command}\n${seen.output.slice(0, 1200)}`);
    }
  }

  return {
    text: summary || last?.text || "",
    tokensIn,
    tokensOut,
    decision: last?.decision ?? null,
    model: last?.model ?? model,
    ghost: false,
    costUsd: costUsd > 0 ? costUsd : null,
    toolCalls: [],
    finishReason: last?.finishReason ?? null,
    hops: Math.max(0, lanes.size - 1),
  };
}

/** Run one tool call, record it on the task, and hand back what to tell the model. */
async function invoke(t: Task, w: Worker, name: string, rawArgs: string, finishReason: string | null): Promise<ToolCall> {
  const seq = `tc_${t.toolCalls.length}`;
  const keep = (rec: ToolCall) => {
    if (rec.result.length > TOOL_RESULT_CAP) {
      rec.result = `${rec.result.slice(0, TOOL_RESULT_CAP)}\n...[truncated ${rec.result.length - TOOL_RESULT_CAP} chars]`;
    }
    t.toolCalls.push({
      ...rec,
      result:
        rec.result.length > TOOL_RECORD_CAP
          ? `${rec.result.slice(0, TOOL_RECORD_CAP)}\n...[${rec.result.length - TOOL_RECORD_CAP} more chars, shown to the desk]`
          : rec.result,
    });
    if (t.toolCalls.length > 120) t.toolCalls.splice(0, t.toolCalls.length - 120);
    store.touch();
    return rec;
  };

  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return keep({
      id: seq, server: "?", tool: name, args: {},
      result:
        finishReason === "length"
          ? `${CUT_OFF_NOTE}\n(the arguments ended at: ...${rawArgs.slice(-120)})`
          : `arguments were not valid JSON: ${rawArgs.slice(0, 200)}`,
      ok: false, ms: 0,
    });
  }

  if (t.workspace && NATIVE_NAMES.has(name)) {
    const started = Date.now();
    store.setWorkerState(w.id, name === "run" ? "delivering" : "typing", shortSay(name, args));
    store.emitEvent({
      type: "tool.call", workerId: w.id, taskId: t.id,
      text: name, data: { server: "floor", tool: name, args: previewArgs(args) },
    });
    let result: string;
    let ok: boolean;
    try {
      const out = await runNative(t, w, name, args);
      result = out.text;
      ok = out.ok;
    } catch (err: any) {
      result = `refused: ${err?.message ?? String(err)}`;
      ok = false;
    }
    const rec = keep({
      id: seq, server: "floor", tool: name, args: previewArgs(args),
      result, ok, ms: Date.now() - started,
    });
    store.emitEvent({
      type: "tool.result", workerId: w.id, taskId: t.id,
      text: `${name} ${ok ? "ok" : "refused"}`,
      data: { server: "floor", tool: name, ok, ms: rec.ms, preview: rec.result.slice(0, 300) },
    });
    return rec;
  }

  const tool = mcp.find(name, w.mcpIds ?? []);
  const started = Date.now();
  if (!tool) {
    return keep({ id: seq, server: "?", tool: name, args, result: `no such tool: ${name}`, ok: false, ms: 0 });
  }

  store.setWorkerState(w.id, "delivering", `${tool.name}...`);
  store.emitEvent({
    type: "tool.call", workerId: w.id, taskId: t.id,
    text: tool.qualified, data: { server: tool.server, tool: tool.name, args },
  });

  let result: string;
  let ok: boolean;
  try {
    result = await mcp.call(tool, args);
    ok = true;
  } catch (err: any) {
    result = `tool failed: ${err?.message ?? String(err)}`;
    ok = false;
  }

  const rec = keep({ id: seq, server: tool.server, tool: tool.name, args, result, ok, ms: Date.now() - started });
  store.emitEvent({
    type: "tool.result", workerId: w.id, taskId: t.id,
    text: `${tool.qualified} ${ok ? "ok" : "failed"}`,
    data: { server: tool.server, tool: tool.name, ok, ms: rec.ms, preview: rec.result.slice(0, 300) },
  });
  return rec;
}

/** A whole file's content in the event log helps nobody. Keep the shape, drop the bulk. */
function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}... (${v.length} chars)` : v;
  }
  return out;
}

/** What the desk mutters while it works, so the bubble says something real. */
function shortSay(name: string, args: Record<string, unknown>): string {
  const file = typeof args.path === "string" ? args.path.split("/").pop() : null;
  switch (name) {
    case "list_files": return "klasore bakiyorum...";
    case "read_file": return file ? `${file} okuyorum` : "okuyorum...";
    case "search_files": return `"${String(args.query ?? "").slice(0, 24)}" ariyorum`;
    case "write_file": return file ? `${file} yaziyorum` : "yaziyorum...";
    case "edit_file": return file ? `${file} duzeltiyorum` : "duzeltiyorum...";
    case "run": return `$ ${String(args.command ?? "").slice(0, 40)}`;
    case "finish": return "bitti, teslim ediyorum.";
    default: return `${name}...`;
  }
}

async function runTask(t: Task, w: Worker) {
  running.add(t.id);
  w.currentTaskId = t.id;
  t.attempts += 1;
  t.workerId = w.id;
  const model = t.modelOverride ?? w.model;
  t.model = model;
  t.startedAt = Date.now();
  t.output = "";
  t.error = null;
  t.toolCalls = [];
  t.files = [];
  t.verifyRuns = [];
  t.hops = 0;
  t.sentPrompt = resolvePrompt(t, previousOutput(t));
  const accept = pick(ACCEPT_LINES);
  store.setStage(t.id, "running");
  store.setWorkerState(w.id, "thinking", accept);
  store.emitEvent({ type: "worker.start", workerId: w.id, taskId: t.id, text: t.title });
  store.emitEvent({ type: "worker.say", workerId: w.id, taskId: t.id, text: accept });

  // throttle stream chunks so the socket doesn't drown
  let buffer = "";
  let lastFlush = 0;
  let typed = false;
  const flush = (force = false) => {
    const now = Date.now();
    if (!buffer) return;
    if (!force && now - lastFlush < 110) return;
    lastFlush = now;
    const text = buffer;
    buffer = "";
    store.emitEvent({ type: "worker.chunk", workerId: w.id, taskId: t.id, text });
  };
  const onChunk = (s: string) => {
    if (t.output.length < 40_000) t.output += s;
    buffer += s;
    if (!typed) {
      typed = true;
      store.setWorkerState(w.id, "typing", null);
    }
    flush();
  };

  const started = Date.now();
  try {
    let result: ChatResult;
    if (gateway.status.online) {
      result = await converse(t, w, model, t.system ?? w.persona ?? HOUSE_RULES, onChunk);
      t.ghost = false;
    } else if (store.state.settings.ghostMode) {
      const text = await ghostRun(t, onChunk);
      result = {
        text, tokensIn: 0, tokensOut: 0, decision: "ghost",
        model: `${model} (ghost)`, ghost: true, toolCalls: [], finishReason: "stop",
      };
      t.ghost = true;
    } else {
      throw new Error("no provider online and ghost mode is off");
    }
    flush(true);

    t.output = (result.text || t.output).trim();
    t.tokensIn = result.tokensIn;
    t.tokensOut = result.tokensOut;
    t.decision = result.decision;
    t.latencyMs = Date.now() - started;
    t.costUsd = t.ghost
      ? 0
      : result.costUsd != null
        ? result.costUsd
        : gateway.costFor(result.model, t.tokensIn, t.tokensOut);
    t.finishedAt = Date.now();

    w.stats.tasksDone += 1;
    w.stats.streak += 1;
    w.stats.tokensIn += t.tokensIn;
    w.stats.tokensOut += t.tokensOut;
    w.stats.costUsd += t.costUsd;
    w.stats.msTotal += t.latencyMs;
    store.state.ledger.tasksDone += 1;
    store.state.ledger.tokensIn += t.tokensIn;
    store.state.ledger.tokensOut += t.tokensOut;
    store.state.ledger.costUsd += t.costUsd;

    store.setWorkerState(w.id, "delivering", pick(DONE_LINES));
    store.emitEvent({
      type: "worker.done", workerId: w.id, taskId: t.id,
      text: t.output.slice(0, 400),
      data: { ms: t.latencyMs, tokensOut: t.tokensOut, cost: t.costUsd, ghost: t.ghost, decision: t.decision, hops: t.hops },
    });
    store.nudgeMorale(w.id, +4);
    store.setStage(t.id, "review");
    advanceJob(t);
  } catch (err: any) {
    flush(true);
    t.error = err?.message ?? String(err);
    t.latencyMs = Date.now() - started;
    t.finishedAt = Date.now();

    // A rate limit is a clock, not a failure. The router already tried every
    // other key and route; what reaches here means all of them are resting.
    if (err instanceof RateLimited && (t.waits ?? 0) < RATE_WAIT_LIMIT) {
      t.waits = (t.waits ?? 0) + 1;
      t.error = null;
      t.stage = "queued";
      holdUntil.set(t.id, Date.now() + err.waitMs);
      const secs = Math.ceil(err.waitMs / 1000);
      const line = `${secs}sn mola - butun anahtarlar dolu`;
      store.setWorkerState(w.id, "coffee", line);
      store.emitEvent({ type: "worker.say", workerId: w.id, taskId: t.id, text: line });
      store.emitEvent({
        type: "system", taskId: t.id, workerId: w.id,
        text: `${model}: every key is resting - waiting ${secs}s`,
        data: { rateLimited: true, waitMs: err.waitMs, model },
      });
      setTimeout(() => {
        const back = store.worker(w.id);
        if (back && back.state === "coffee") {
          store.setWorkerState(back.id, "idle", null);
          store.touch();
        }
      }, err.waitMs);
      store.touch();
      return;
    }

    // Nothing serves the model this desk sits on. The auto route might.
    const unservable = /nothing serves|not served by|no provider can serve/i.test(t.error ?? "");
    if (unservable && !t.modelOverride && model !== "auto" && store.state.settings.routerFallback !== false) {
      t.modelOverride = "auto";
      t.fallbackFrom = model;
      t.error = null;
      t.stage = "queued";
      const line = fallbackLine(model.split("/").pop() ?? model);
      store.setWorkerState(w.id, "idle", line);
      store.emitEvent({ type: "worker.say", workerId: w.id, taskId: t.id, text: line });
      store.emitEvent({
        type: "system", taskId: t.id, workerId: w.id,
        text: `${model} unavailable - retrying on auto`,
        data: { fallbackFrom: model },
      });
      store.touch();
      return;
    }
    w.stats.tasksFailed += 1;
    w.stats.streak = 0;
    store.state.ledger.tasksFailed += 1;
    store.setWorkerState(w.id, "burnt", unservable ? "o model icin anahtar yok." : pick(FAIL_LINES));
    store.emitEvent({ type: "worker.fail", workerId: w.id, taskId: t.id, text: t.error ?? "unknown failure" });
    store.nudgeMorale(w.id, -14);

    if (t.retriesLeft > 0) {
      t.retriesLeft -= 1;
      t.error = null;
      t.workerId = null;
      t.stage = "queued";
      store.emitEvent({
        type: "system", taskId: t.id,
        text: `${t.title}: baska masaya veriliyor (${t.retriesLeft} deneme kaldi)`,
        data: { retry: true },
      });
      store.touch();
      return;
    }

    store.setStage(t.id, "failed");
    advanceJob(t);
    const job = store.job(t.jobId);
    if (job && job.kind === "pipeline") {
      job.stage = "failed";
      settlePlan(job.id, "failed");
      store.emitEvent({ type: "job.done", text: `${job.title} broke down`, data: { jobId: job.id, ok: false } });
    }
  } finally {
    running.delete(t.id);
    w.currentTaskId = null;
    setTimeout(() => {
      const still = store.worker(w.id);
      if (!still || (still.state !== "delivering" && still.state !== "burnt")) return;
      // a desk with work queued on it goes straight back to it - coffee is for quiet nights
      const waiting = store.state.tasks.some((x) => x.stage === "queued" && (x.workerId === still.id || !x.workerId));
      const earned = still.stats.tasksDone > 0 && still.stats.tasksDone % 4 === 0;
      if (!waiting && (earned || still.morale < 30)) {
        store.setWorkerState(still.id, "coffee", COFFEE_LINE);
        store.emitEvent({ type: "worker.say", workerId: still.id, text: COFFEE_LINE });
        setTimeout(() => {
          const back = store.worker(still.id);
          if (back && back.state === "coffee") {
            store.setWorkerState(back.id, "idle", null);
            store.nudgeMorale(back.id, +10);
          }
        }, 9000);
      } else {
        store.setWorkerState(still.id, "idle", null);
      }
    }, 2600);
    store.touch();
  }
}

const settled = (t: Task | undefined) => !t || t.stage === "review" || t.stage === "done" || t.stage === "failed";

/** Queue the next step of a pipeline, the next wave of a plan, or tally a batch. */
function advanceJob(t: Task) {
  if (!t.jobId) return;
  const job = store.job(t.jobId);
  if (!job) return;
  const tasks = job.taskIds.map((i) => store.task(i)).filter(Boolean) as Task[];

  const close = () => {
    const failed = tasks.filter((x) => x.stage === "failed").length;
    job.stage = failed && job.kind !== "waves" ? "failed" : "done";
    // a wave plan with a failed step is not over: the final check and the fixer
    // are exactly what picks up after a desk that could not finish
    settlePlan(job.id, failed && job.kind !== "waves" ? "failed" : "done");
    store.emitEvent({
      type: "job.done",
      text: `${job.title}: ${tasks.length - failed}/${tasks.length} geldi`,
      data: { jobId: job.id, ok: !failed },
    });
    store.touch();
  };

  if (job.kind === "batch") {
    if (tasks.every(settled)) close();
    return;
  }

  if (job.kind === "waves") {
    releaseWaves(job.id);
    return;
  }

  const next = job.taskIds[t.stepIndex + 1];
  if (next) {
    const nt = store.task(next);
    if (nt && nt.stage === "backlog") {
      nt.stage = "queued";
      wake(nt.workerId);
      store.emitEvent({ type: "task.stage", taskId: nt.id, text: "queued", data: { via: "pipeline" } });
      store.touch();
    }
  } else {
    close();
  }
}

/**
 * Release the next wave of a wave job, or close the job when nothing is left.
 * A wave goes out only when every task of the waves before it has settled.
 */
export function releaseWaves(jobId: string) {
  const job = store.job(jobId);
  if (!job) return;
  const tasks = job.taskIds.map((i) => store.task(i)).filter(Boolean) as Task[];
  {
    const open = tasks.filter((x) => !settled(x));
    const releasable = open.filter((x) => x.stage === "backlog");
    const busy = open.filter((x) => x.stage !== "backlog");
    if (!open.length) {
      const failed = tasks.filter((x) => x.stage === "failed").length;
      job.stage = "done";
      settlePlan(job.id, "done");
      store.emitEvent({
        type: "job.done",
        text: `${job.title}: ${tasks.length - failed}/${tasks.length} geldi`,
        data: { jobId: job.id, ok: !failed },
      });
      store.touch();
      return;
    }
    if (busy.length || !releasable.length) return;
    const next = Math.min(...releasable.map((x) => x.wave ?? 1));
    const wave = releasable.filter((x) => (x.wave ?? 1) === next);
    for (const nt of wave) {
      nt.stage = "queued";
      wake(nt.workerId);
      store.emitEvent({ type: "task.stage", taskId: nt.id, text: "queued", data: { via: "wave", wave: next } });
    }
    store.emitEvent({ type: "boss.say", text: `dalga ${next}: ${wave.length} masa basliyor.`, data: { wave: next } });
    store.touch();
  }
}

/** A plan is done when the job it was cut into is done. */
function settlePlan(jobId: string, status: "done" | "failed") {
  const plan = store.state.plans.find((p) => p.jobId === jobId);
  if (!plan || plan.status !== "running") return;
  plan.status = status;
  store.touch();
  if (status === "done" && plan.kind === "build" && plan.workspace && plan.verify) {
    void finalCheck(plan);
  }
}

/**
 * Run the plan's check once the whole floor has landed, and if it fails, put a
 * desk on repairing it. The repair desk owns the whole folder, because a
 * failure at this point is almost always between two steps rather than inside
 * one of them.
 */
async function finalCheck(plan: Plan) {
  if (!plan.workspace || !plan.verify) return;
  store.emitEvent({ type: "boss.say", text: `son kontrol: ${plan.verify}`, data: { planId: plan.id } });
  const res = await shell(plan.verify, plan.workspace);
  store.emitEvent({
    type: "verify",
    text: `${plan.verify} ${res.ok ? "passed" : "failed"}`,
    data: { ok: res.ok, planId: plan.id, command: plan.verify, ms: res.ms, preview: res.text.slice(0, 400) },
  });
  if (res.ok) {
    store.emitEvent({ type: "boss.say", text: "calisiyor. herkese iyi geceler.", data: { planId: plan.id, final: true } });
    store.touch();
    return;
  }

  plan.status = "failed";
  const failed = plan.steps
    .map((s) => store.task(s.taskId))
    .filter((x): x is Task => Boolean(x && x.stage === "failed"));
  const t = store.addTask({
    title: `fix: ${plan.title}`,
    prompt: [
      "The project in this folder does not pass its check yet. Make it pass.",
      "",
      `$ ${plan.verify}`,
      res.text.slice(-5000),
      "",
      failed.length
        ? `These steps did not finish, so their files may be missing or partial: ${failed.map((f) => `${f.title} (${f.claims.join(", ")})`).join("; ")}. Write whatever is missing, to the standard of the rest of the project.`
        : "",
      "Several engineers wrote different parts of this at once, so the fault is most likely between two files:",
      "an export name that does not match its import, props that differ from the contract, a missing file.",
      "You own the whole folder. Read the failing lines, fix the real cause with edit_file (do not rewrite working",
      "files from scratch, do not delete features to make errors go away), run the check, and finish when it passes.",
    ].filter(Boolean).join("\n"),
    createdBy: "boss",
    stage: "queued",
    planId: plan.id,
    retriesLeft: 1,
    workspace: plan.workspace,
    claims: ["**"],
    verify: plan.verify,
  });
  dispatch(t.id, null, "check patladi - biri bunu toparlasin.");
  store.touch();
}

/** Work landing on a sleeping desk wakes it up - the boss is standing right there. */
export function wake(workerId: string | null | undefined) {
  const w = store.worker(workerId);
  if (!w || (w.state !== "asleep" && w.state !== "coffee")) return;
  const line = w.state === "asleep" ? "uyandim uyandim." : "kahvem yarim kaldi.";
  store.setWorkerState(w.id, "idle", line);
  store.emitEvent({ type: "worker.say", workerId: w.id, text: line });
}

/** Boss walks over, says the line, and the desk starts a beat later. */
export function dispatch(taskId: string, workerId: string | null, line?: string) {
  const t = store.task(taskId);
  if (!t) return;
  if (workerId) t.workerId = workerId;
  wake(t.workerId);
  t.stage = "queued";
  holdUntil.set(t.id, Date.now() + THEATRE_MS);
  store.emitEvent({
    type: "boss.order",
    taskId: t.id,
    workerId: t.workerId ?? undefined,
    text: line || t.title,
    data: { desk: store.worker(t.workerId)?.desk ?? null },
  });
  store.touch();
}

export function tick() {
  const s = store.state;
  if (running.size >= s.settings.maxParallel) return;

  const queue = s.tasks
    .filter((t) => t.stage === "queued" && !running.has(t.id))
    .sort((a, b) => a.createdAt - b.createdAt);

  const claimed = new Set(
    s.tasks
      .filter((t) => (t.stage === "queued" || t.stage === "running") && t.workerId)
      .map((t) => t.workerId!),
  );

  for (const t of queue) {
    if (running.size >= s.settings.maxParallel) break;
    const hold = holdUntil.get(t.id);
    if (hold && hold > Date.now()) continue;
    holdUntil.delete(t.id);

    let w = store.worker(t.workerId);
    if (w && (w.state === "asleep" || w.state === "coffee") && !w.currentTaskId) {
      wake(w.id);
      continue;
    }
    if (w && (w.state !== "idle" || w.currentTaskId)) {
      // the pinned desk is busy with something else: a split plan should not queue
      // behind one desk while another sits idle, so a waiting wave task moves
      if (t.jobId && store.job(t.jobId)?.kind !== "pipeline" && s.settings.autoAssign) {
        const free = idleWorkers().filter((x) => !claimed.has(x.id));
        if (free.length && (w.currentTaskId && store.task(w.currentTaskId)?.jobId === t.jobId)) {
          const other = free.sort((a, b) => a.stats.tasksDone - b.stats.tasksDone)[0];
          t.workerId = other.id;
          claimed.add(other.id);
          store.emitEvent({ type: "boss.order", taskId: t.id, workerId: other.id, text: t.title, data: { auto: true } });
          holdUntil.set(t.id, Date.now() + THEATRE_MS);
        }
      }
      continue;
    }
    if (!w) {
      if (!s.settings.autoAssign) continue;
      const free = idleWorkers().filter((x) => !claimed.has(x.id));
      if (!free.length) continue;
      const servable = free.filter((x) => gateway.servable(x.model));
      const pool = servable.length ? servable : free;
      w = pool.sort((a, b) => a.stats.tasksDone - b.stats.tasksDone)[0];
      t.workerId = w.id;
      claimed.add(w.id);
      store.emitEvent({ type: "boss.order", taskId: t.id, workerId: w.id, text: t.title, data: { auto: true } });
      holdUntil.set(t.id, Date.now() + THEATRE_MS);
      continue;
    }
    void runTask(t, w);
  }
}

/** Empty rooms are sad. Let the idle ones mutter. */
export function chatter() {
  const idle = store.state.workers.filter((w) => w.state === "idle");
  if (!idle.length) return;
  const w = pick(idle);
  const line = pick(IDLE_LINES);
  w.saying = line;
  store.emitEvent({ type: "worker.say", workerId: w.id, text: line });
  store.touch();
}

/** Push the router's live picture - who is resting, who is busy - into the floor state. */
export function syncRouter() {
  gateway.reasoning = store.state.settings.reasoning ?? "low";
  gateway.fallback = store.state.settings.routerFallback !== false;
  const before = store.state.gateway;
  const next = gateway.snapshot();
  const busy = next.providers.some((p) => p.lanes.some((l) => l.inflight || l.coolUntil));
  const was = before?.providers?.some((p) => p.lanes.some((l) => l.inflight || l.coolUntil));
  store.state.gateway = next;
  if (busy || was) store.touch();
}

export function startEngine() {
  setInterval(tick, 500);
  setInterval(chatter, 24_000);
  setInterval(syncRouter, 2_500);
  setInterval(async () => {
    const before = gateway.status.online;
    const st = await gateway.refresh();
    store.state.gateway = st;
    if (st.online !== before) {
      store.emitEvent({
        type: "gateway",
        text: st.online ? `providers up - ${st.modelCount} models on the board` : `no provider answering - ${st.error ?? ""}`,
        data: { online: st.online },
      });
    }
    store.touch();
  }, 120_000);
}
