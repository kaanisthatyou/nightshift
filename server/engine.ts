// The shift itself: who works on what, when, and what it costs.
import { Gateway, RateLimited } from "./omniroute.ts";
import { asOpenAiTools, mcp } from "./mcp.ts";
import { store } from "./store.ts";
import {
  ACCEPT_LINES, COFFEE_LINE, DONE_LINES, FAIL_LINES, GHOST_NOTE, IDLE_LINES, fallbackLine, pick,
} from "./flavor.ts";
import { HOUSE_RULES } from "../shared/presets.ts";
import type { ChatResult } from "./omniroute.ts";
import type { Task, ToolCall, Worker } from "../shared/types.ts";

export const gateway = new Gateway({
  baseUrl: process.env.OMNIROUTE_URL || "http://localhost:20128/v1",
  apiKey: process.env.OMNIROUTE_KEY || "",
});

/**
 * Tasks the boss just walked over to: hold them until the walk animation lands.
 * A rate-limited task parks in the same map, for as long as the provider said.
 */
const holdUntil = new Map<string, number>();
export const THEATRE_MS = 2200;

/** After this many waits in a row it is not a busy minute, it is a wall. */
const RATE_WAIT_LIMIT = 4;

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
  if (!t.jobId || t.stepIndex === 0) return "";
  const job = store.job(t.jobId);
  if (!job) return "";
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
const TOOL_RESULT_CAP = 6000;

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

/**
 * The tool loop. Runs the model, executes whatever it asked for, feeds the
 * results back, and repeats until it answers in words or burns its rounds.
 * With no tools on the desk this is a single pass and behaves exactly as before.
 */
async function converse(
  t: Task,
  w: Worker,
  model: string,
  system: string | null,
  onChunk: (s: string) => void,
): Promise<ChatResult> {
  const tools = deskTools(w);
  const defs = asOpenAiTools(tools);
  const messages: any[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: t.sentPrompt ?? t.prompt });

  const maxRounds = Math.max(1, store.state.settings.mcpMaxRounds || 6);
  let last: ChatResult | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;

  for (let round = 0; round < maxRounds; round++) {
    // the last round goes out without tools, so the desk has to write an answer
    const offerTools = defs.length > 0 && round < maxRounds - 1;
    const res = await gateway.chat({
      model,
      messages,
      maxTokens: 1600,
      signal: AbortSignal.timeout(180_000),
      onChunk,
      ...(offerTools ? { tools: defs } : {}),
    });
    // usage is per call - the task should show what the whole conversation cost
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;
    if (res.costUsd != null) costUsd += res.costUsd;
    last = res;

    if (!res.toolCalls.length) break;

    messages.push({
      role: "assistant",
      content: res.text || null,
      tool_calls: res.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      })),
    });

    for (const call of res.toolCalls) {
      const record = await invoke(t, w, call.name, call.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: record.result });
    }
    // the desk goes back to thinking while the next round starts
    store.setWorkerState(w.id, "thinking", null);
  }

  const totalCost = costUsd > 0 ? costUsd : null;
  return {
    text: last?.text ?? "",
    tokensIn,
    tokensOut,
    decision: last?.decision ?? null,
    model: last?.model ?? model,
    ghost: false,
    costUsd: totalCost,
    toolCalls: [],
    finishReason: last?.finishReason ?? null,
  };
}

/** Run one tool call, record it on the task, and hand back what to tell the model. */
async function invoke(t: Task, w: Worker, qualified: string, rawArgs: string): Promise<ToolCall> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    // small models hand back almost-JSON often enough to be worth saying so plainly
    const rec: ToolCall = {
      id: `tc_${t.toolCalls.length}`, server: "?", tool: qualified, args: {},
      result: `arguments were not valid JSON: ${rawArgs.slice(0, 200)}`, ok: false, ms: 0,
    };
    t.toolCalls.push(rec);
    store.touch();
    return rec;
  }

  const tool = mcp.find(qualified, w.mcpIds ?? []);
  const started = Date.now();
  if (!tool) {
    const rec: ToolCall = {
      id: `tc_${t.toolCalls.length}`, server: "?", tool: qualified, args,
      result: `no such tool: ${qualified}`, ok: false, ms: 0,
    };
    t.toolCalls.push(rec);
    store.touch();
    return rec;
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
  if (result.length > TOOL_RESULT_CAP) {
    result = `${result.slice(0, TOOL_RESULT_CAP)}\n...[truncated ${result.length - TOOL_RESULT_CAP} chars]`;
  }

  const rec: ToolCall = {
    id: `tc_${t.toolCalls.length}`,
    server: tool.server, tool: tool.name, args, result, ok, ms: Date.now() - started,
  };
  t.toolCalls.push(rec);
  store.emitEvent({
    type: "tool.result", workerId: w.id, taskId: t.id,
    text: `${tool.qualified} ${ok ? "ok" : "failed"}`,
    data: { server: tool.server, tool: tool.name, ok, ms: rec.ms, preview: result.slice(0, 300) },
  });
  store.touch();
  return rec;
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
    t.output += s;
    buffer += s;
    if (!typed) {
      typed = true;
      store.setWorkerState(w.id, "typing", null);
    }
    flush();
  };

  const started = Date.now();
  try {
    let result;
    if (gateway.status.online) {
      result = await converse(
        t, w, model,
        // an explicit system on the task wins; otherwise the desk answers as itself
        t.system ?? w.persona ?? HOUSE_RULES,
        onChunk,
      );
      t.ghost = false;
    } else if (store.state.settings.ghostMode) {
      const text = await ghostRun(t, onChunk);
      result = {
        text, tokensIn: 0, tokensOut: 0, decision: "ghost",
        model: `${model} (ghost)`, ghost: true, toolCalls: [], finishReason: "stop",
      };
      t.ghost = true;
    } else {
      throw new Error("gateway offline and ghost mode is off");
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
        : gateway.costFor(model, t.tokensIn, t.tokensOut);
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
      data: { ms: t.latencyMs, tokensOut: t.tokensOut, cost: t.costUsd, ghost: t.ghost, decision: t.decision },
    });
    store.nudgeMorale(w.id, +4);
    store.setStage(t.id, "review");
    advanceJob(t);
  } catch (err: any) {
    flush(true);
    t.error = err?.message ?? String(err);
    const missing = /model_not_found|no active credentials|not supported|invalid_api_key|40[14]/i.test(t.error ?? "");
    t.latencyMs = Date.now() - started;
    t.finishedAt = Date.now();

    // A rate limit is a clock, not a failure. The desk takes a real coffee for
    // exactly as long as the provider asked for, and the task waits with it -
    // no retry spent, no morale lost, nothing marked failed.
    if (err instanceof RateLimited && (t.waits ?? 0) < RATE_WAIT_LIMIT) {
      t.waits = (t.waits ?? 0) + 1;
      t.error = null;
      t.stage = "queued";
      holdUntil.set(t.id, Date.now() + err.waitMs);

      // once is the minute window; twice is that model's quota, and the router
      // (whatever combo omniroute has live) has other providers to spend
      const toRouter = t.waits >= 2 && !t.modelOverride && model !== "auto" && gateway.status.online;
      if (toRouter) {
        t.modelOverride = "auto";
        t.fallbackFrom = model;
      }

      const secs = Math.ceil(err.waitMs / 1000);
      const line = toRouter ? `${secs}sn mola - kotam doldu, routera geciyorum` : `${secs}sn mola - kota doldu`;
      store.setWorkerState(w.id, "coffee", line);
      store.emitEvent({ type: "worker.say", workerId: w.id, taskId: t.id, text: line });
      store.emitEvent({
        type: "system",
        taskId: t.id,
        workerId: w.id,
        text: toRouter
          ? `${model} rate limited - ${secs}s, then the router takes it`
          : `${model} rate limited - waiting ${secs}s`,
        data: { rateLimited: true, waitMs: err.waitMs, model, toRouter },
      });
      // the desk comes back when the window does, not on the usual 2.6s timer
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

    // The catalog lists models the provider will not actually serve. Hand the job to
    // OmniRoute's own router instead of failing - but say so, on the record.
    if (missing && !t.modelOverride && model !== "auto" && gateway.status.online) {
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
      return; // the finally block below hands the desk back
    }
    w.stats.tasksFailed += 1;
    w.stats.streak = 0;
    store.state.ledger.tasksFailed += 1;
    store.setWorkerState(w.id, "burnt", missing ? "o model icin bana hesap vermediler." : pick(FAIL_LINES));
    store.emitEvent({ type: "worker.fail", workerId: w.id, taskId: t.id, text: t.error ?? "unknown failure" });
    store.nudgeMorale(w.id, -14);

    // a retry budget means the work goes back on the pile - and to a different desk
    if (t.retriesLeft > 0) {
      t.retriesLeft -= 1;
      t.error = null;
      t.workerId = null;
      t.stage = "queued";
      store.emitEvent({
        type: "system",
        taskId: t.id,
        text: `${t.title}: baska masaya veriliyor (${t.retriesLeft} deneme kaldi)`,
        data: { retry: true },
      });
      store.touch();
      return;
    }

    store.setStage(t.id, "failed");
    advanceJob(t);
    // one broken step kills a pipeline; a batch just counts it and carries on
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
      // nobody grinds forever: every fourth job, or when they're miserable, they walk off
      const earned = still.stats.tasksDone > 0 && still.stats.tasksDone % 4 === 0;
      if (earned || still.morale < 30) {
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

/** Queue the next step of a pipeline once a step lands. Batches just tally up. */
function advanceJob(t: Task) {
  if (!t.jobId) return;
  const job = store.job(t.jobId);
  if (!job) return;

  if (job.kind === "batch") {
    const tasks = job.taskIds.map((i) => store.task(i)).filter(Boolean) as Task[];
    const open = tasks.filter((x) => x.stage === "queued" || x.stage === "running" || x.stage === "backlog");
    if (!open.length) {
      const failed = tasks.filter((x) => x.stage === "failed").length;
      job.stage = failed ? "failed" : "done";
      settlePlan(job.id, failed ? "failed" : "done");
      store.emitEvent({
        type: "job.done",
        text: `${job.title}: ${tasks.length - failed}/${tasks.length} geldi`,
        data: { jobId: job.id, ok: !failed },
      });
      store.touch();
    }
    return;
  }

  const next = job.taskIds[t.stepIndex + 1];
  if (next) {
    const nt = store.task(next);
    if (nt && nt.stage === "backlog") {
      nt.stage = "queued";
      store.emitEvent({ type: "task.stage", taskId: nt.id, text: "queued", data: { via: "pipeline" } });
      store.touch();
    }
  } else {
    job.stage = "done";
    settlePlan(job.id, "done");
    store.emitEvent({ type: "job.done", text: `${job.title} cleared the floor`, data: { jobId: job.id, ok: true } });
    store.touch();
  }
}

/** A plan is done when the job it was cut into is done. */
function settlePlan(jobId: string, status: "done" | "failed") {
  const plan = store.state.plans.find((p) => p.jobId === jobId);
  if (!plan || plan.status !== "running") return;
  plan.status = status;
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

  // a desk that already has something queued on it is not free, even if it looks idle
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
    if (w && (w.state !== "idle" || w.currentTaskId)) continue;
    if (!w) {
      if (!s.settings.autoAssign) continue;
      const free = idleWorkers().filter((x) => !claimed.has(x.id));
      if (!free.length) continue;
      // a desk whose model the gateway doesn't serve is a dead end - skip it if we can
      const servable = free.filter((x) => !gateway.models.length || x.model === "auto" || gateway.models.some((m) => m.id === x.model));
      const pool = servable.length ? servable : free;
      // whoever is least loaded takes it
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

export function startEngine() {
  setInterval(tick, 500);
  setInterval(chatter, 24_000);
  setInterval(async () => {
    const before = gateway.status.online;
    const st = await gateway.refresh();
    store.state.gateway = st;
    if (st.online !== before) {
      store.emitEvent({
        type: "gateway",
        text: st.online ? `gateway up - ${st.modelCount} models on the board` : `gateway down - ${st.error ?? "no answer"}`,
        data: { online: st.online },
      });
    }
    store.touch();
  }, 15_000);
}
