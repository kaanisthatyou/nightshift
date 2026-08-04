// The shift itself: who works on what, when, and what it costs.
import { Gateway } from "./omniroute.ts";
import { store } from "./store.ts";
import {
  ACCEPT_LINES, COFFEE_LINE, DONE_LINES, FAIL_LINES, GHOST_NOTE, IDLE_LINES, fallbackLine, pick,
} from "./flavor.ts";
import type { Task, Worker } from "../shared/types.ts";

export const gateway = new Gateway({
  baseUrl: process.env.OMNIROUTE_URL || "http://localhost:20128/v1",
  apiKey: process.env.OMNIROUTE_KEY || "",
});

/** Tasks the boss just walked over to: hold them until the walk animation lands. */
const holdUntil = new Map<string, number>();
export const THEATRE_MS = 2200;

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
      result = await gateway.chat({
        model,
        prompt: t.sentPrompt,
        system:
          t.system ??
          "You are a worker on a night shift. Do exactly the task you are given, nothing more. " +
            "Be concise and concrete. No preamble, no sign-off. " +
            "Answer in the same language the task is written in.",
        signal: AbortSignal.timeout(180_000),
        onChunk,
      });
      t.ghost = false;
    } else if (store.state.settings.ghostMode) {
      const text = await ghostRun(t, onChunk);
      result = { text, tokensIn: 0, tokensOut: 0, decision: "ghost", model: `${model} (ghost)`, ghost: true };
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
    store.emitEvent({ type: "job.done", text: `${job.title} cleared the floor`, data: { jobId: job.id, ok: true } });
    store.touch();
  }
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
