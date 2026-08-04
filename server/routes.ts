// REST surface. The window uses it, and so does Claude when it plays boss.
import { Router } from "express";
import { id, store } from "./store.ts";
import { dispatch, gateway, wake } from "./engine.ts";
import { BOSS_LINES, pick } from "./flavor.ts";
import { fireHappening, happeningKinds } from "./nightlife.ts";
import type { Task } from "../shared/types.ts";

export const api = Router();

const snapshot = () => ({ state: store.state, models: gateway.models, log: store.log.slice(-120) });

api.get("/health", (_req, res) => {
  res.json({ ok: true, gateway: store.state.gateway, workers: store.state.workers.length });
});

api.get("/state", (_req, res) => res.json(snapshot()));

api.get("/models", async (req, res) => {
  if (req.query.refresh || !gateway.models.length) {
    store.state.gateway = await gateway.refresh();
    store.touch();
  }
  res.json({ models: gateway.models, gateway: store.state.gateway });
});

api.post("/gateway", async (req, res) => {
  const { baseUrl, apiKey } = req.body ?? {};
  gateway.setConfig({
    ...(typeof baseUrl === "string" && baseUrl ? { baseUrl } : {}),
    ...(typeof apiKey === "string" ? { apiKey } : {}),
  });
  store.state.gateway = await gateway.refresh();
  store.emitEvent({
    type: "gateway",
    text: store.state.gateway.online ? "gateway reconnected" : `gateway refused: ${store.state.gateway.error}`,
    data: { online: store.state.gateway.online },
  });
  store.touch();
  res.json({ gateway: store.state.gateway, models: gateway.models });
});

api.post("/settings", (req, res) => {
  const s = store.state.settings;
  const b = req.body ?? {};
  if (typeof b.autoAssign === "boolean") s.autoAssign = b.autoAssign;
  if (typeof b.ghostMode === "boolean") s.ghostMode = b.ghostMode;
  if (typeof b.maxParallel === "number") s.maxParallel = Math.max(1, Math.min(8, b.maxParallel));
  if (typeof b.defaultModel === "string" && b.defaultModel) s.defaultModel = b.defaultModel;
  store.touch();
  res.json({ settings: s });
});

// ---- workers ---------------------------------------------------------

api.post("/workers", (req, res) => {
  const w = store.hire({ name: req.body?.name, model: req.body?.model, title: req.body?.title });
  if (!w) return res.status(409).json({ error: "no free desks - fire someone first" });
  res.json({ worker: w });
});

api.patch("/workers/:id", (req, res) => {
  const w = store.worker(req.params.id);
  if (!w) return res.status(404).json({ error: "no such worker" });
  const b = req.body ?? {};
  if (typeof b.model === "string" && b.model) {
    w.model = b.model;
    store.emitEvent({ type: "worker.say", workerId: w.id, text: `reassigned to ${b.model.split("/").pop()}` });
  }
  if (typeof b.name === "string" && b.name) w.name = b.name;
  if (typeof b.title === "string") w.title = b.title;
  if (b.state === "asleep" || b.state === "idle") w.state = b.state;
  store.touch();
  res.json({ worker: w });
});

api.delete("/workers/:id", (req, res) => {
  const ok = store.fire(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

// ---- tasks -----------------------------------------------------------

function waitForTask(id: string, ms: number): Promise<Task | undefined> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const check = () => {
      const t = store.task(id);
      if (!t) return resolve(undefined);
      if (t.stage === "review" || t.stage === "done" || t.stage === "failed") return resolve(t);
      if (Date.now() > deadline) return resolve(t);
      setTimeout(check, 250);
    };
    check();
  });
}

api.get("/tasks", (req, res) => {
  const stage = req.query.stage as string | undefined;
  const list = stage ? store.state.tasks.filter((t) => t.stage === stage) : store.state.tasks;
  res.json({ tasks: list.slice(-100) });
});

api.get("/tasks/:id", (req, res) => {
  const t = store.task(req.params.id);
  if (!t) return res.status(404).json({ error: "no such task" });
  res.json({ task: t });
});

api.post("/tasks", async (req, res) => {
  const b = req.body ?? {};
  if (!b.prompt) return res.status(400).json({ error: "prompt required" });
  const t = store.addTask({
    title: b.title || String(b.prompt).split("\n")[0].slice(0, 60),
    prompt: String(b.prompt),
    system: b.system ?? null,
    workerId: b.workerId ?? null,
    createdBy: b.createdBy === "boss" ? "boss" : "you",
    stage: "backlog",
  });
  if (b.dispatch !== false) dispatch(t.id, b.workerId ?? null, b.line);
  if (b.wait) {
    const done = await waitForTask(t.id, Number(b.waitMs) || 120_000);
    return res.json({ task: done });
  }
  res.json({ task: t });
});

api.post("/tasks/:id/dispatch", (req, res) => {
  const t = store.task(req.params.id);
  if (!t) return res.status(404).json({ error: "no such task" });
  dispatch(t.id, req.body?.workerId ?? t.workerId, req.body?.line);
  res.json({ task: t });
});

api.post("/tasks/:id/approve", (req, res) => {
  const t = store.task(req.params.id);
  if (!t) return res.status(404).json({ error: "no such task" });
  store.setStage(t.id, "done");
  if (t.workerId) {
    store.nudgeMorale(t.workerId, +8);
    store.emitEvent({ type: "boss.say", workerId: t.workerId, text: req.body?.note || "iyi. sirada ne var." });
  }
  res.json({ task: t });
});

api.post("/tasks/:id/reject", (req, res) => {
  const t = store.task(req.params.id);
  if (!t) return res.status(404).json({ error: "no such task" });
  t.reviewNote = req.body?.note || "bu olmamis. bastan yap.";
  t.stage = "rejected";
  if (t.workerId) {
    store.nudgeMorale(t.workerId, -12);
    store.emitEvent({ type: "boss.say", workerId: t.workerId, text: t.reviewNote ?? "tekrar.", taskId: t.id });
  }
  store.touch();
  if (req.body?.rework !== false) dispatch(t.id, t.workerId, "bastan yap.");
  res.json({ task: t });
});

api.post("/tasks/:id/retry", (req, res) => {
  const t = store.task(req.params.id);
  if (!t) return res.status(404).json({ error: "no such task" });
  t.error = null;
  dispatch(t.id, req.body?.workerId ?? t.workerId, "bir daha dene.");
  res.json({ task: t });
});

// ---- pipelines -------------------------------------------------------

api.post("/jobs", (req, res) => {
  const b = req.body ?? {};
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!steps.length) return res.status(400).json({ error: "steps required" });
  const ids: string[] = [];
  const job = store.addJob(b.title || "untitled pipeline", ids, "pipeline");
  steps.forEach((s: any, i: number) => {
    const t = store.addTask({
      title: s.title || `step ${i + 1}`,
      prompt: String(s.prompt ?? ""),
      system: s.system ?? null,
      workerId: s.workerId ?? null,
      createdBy: "pipeline",
      stage: i === 0 ? "backlog" : "backlog",
      jobId: job.id,
      stepIndex: i,
    });
    ids.push(t.id);
  });
  job.taskIds = ids;
  dispatch(ids[0], steps[0].workerId ?? null, `pipeline: ${job.title}`);
  store.touch();
  res.json({ job, tasks: ids.map((i) => store.task(i)) });
});

/** One list, split across every free desk. */
api.post("/batch", (req, res) => {
  const b = req.body ?? {};
  const items: string[] = (Array.isArray(b.items) ? b.items : String(b.items ?? "").split("\n"))
    .map((x: string) => String(x).trim())
    .filter(Boolean);
  if (!items.length) return res.status(400).json({ error: "items required (array or newline separated)" });
  if (items.length > 60) return res.status(400).json({ error: "60 items at a time is plenty" });

  const template = String(b.template ?? b.prompt ?? "").trim();
  if (!template) return res.status(400).json({ error: "template required - use {{item}} for each line" });
  const retries = Math.max(0, Math.min(3, Number(b.retries ?? 1)));
  const workerIds: string[] | null = Array.isArray(b.workerIds) && b.workerIds.length ? b.workerIds : null;

  const ids: string[] = [];
  const job = store.addJob(b.title || `batch · ${items.length} items`, ids, "batch");
  items.forEach((item, i) => {
    const prompt = template.includes("{{item}}")
      ? template.replaceAll("{{item}}", item)
      : `${template}\n\n${item}`;
    const t = store.addTask({
      title: `${i + 1}/${items.length} · ${item.slice(0, 40)}`,
      prompt,
      system: b.system ?? null,
      workerId: workerIds ? workerIds[i % workerIds.length] : null,
      createdBy: "pipeline",
      stage: "queued",
      jobId: job.id,
      stepIndex: i,
      retriesLeft: retries,
    });
    ids.push(t.id);
  });
  job.taskIds = ids;
  for (const w of store.state.workers) wake(w.id);
  store.emitEvent({
    type: "boss.say",
    text: b.line || `${items.length} parca is. paylasin.`,
    data: { jobId: job.id },
  });
  store.touch();
  res.json({ job, taskIds: ids });
});

api.get("/jobs/:id", (req, res) => {
  const job = store.job(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({ job, tasks: job.taskIds.map((i) => store.task(i)) });
});

// ---- the arena -------------------------------------------------------

/** Same prompt, several desks, one winner. */
api.post("/arena", (req, res) => {
  const b = req.body ?? {};
  const text = String(b.text ?? b.prompt ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  const chosen: string[] = Array.isArray(b.workerIds) && b.workerIds.length
    ? b.workerIds
    : store.state.workers.map((w) => w.id);
  const workers = chosen.map((wid) => store.worker(wid)).filter(Boolean);
  if (workers.length < 2) return res.status(400).json({ error: "pick at least two desks" });

  const arenaId = id("arena");
  for (const w of workers) wake(w!.id); // a bell wakes the whole floor
  const tasks = workers.map((w) =>
    store.addTask({
      title: `arena · ${text.slice(0, 40)}`,
      prompt: text,
      system: b.system ?? null,
      workerId: w!.id,
      createdBy: "boss",
      stage: "queued",
      arenaId,
    }),
  );
  store.emitEvent({
    type: "boss.say",
    text: b.line || "ayni isi hepinize veriyorum. bakalim kim daha iyi.",
    data: { arenaId },
  });
  store.touch();
  res.json({ arenaId, tasks });
});

api.get("/arena/:id", (req, res) => {
  const tasks = store.state.tasks.filter((t) => t.arenaId === req.params.id);
  if (!tasks.length) return res.status(404).json({ error: "no such arena" });
  res.json({
    arenaId: req.params.id,
    tasks,
    done: tasks.every((t) => t.stage !== "queued" && t.stage !== "running"),
  });
});

api.post("/arena/:id/winner", (req, res) => {
  const tasks = store.state.tasks.filter((t) => t.arenaId === req.params.id);
  if (!tasks.length) return res.status(404).json({ error: "no such arena" });
  const winnerId = String(req.body?.taskId ?? "");
  const winner = tasks.find((t) => t.id === winnerId);
  if (!winner) return res.status(400).json({ error: "taskId is not in this arena" });

  for (const t of tasks) t.wonArena = t.id === winner.id;
  const w = store.worker(winner.workerId);
  if (w) {
    w.stats.wins = (w.stats.wins ?? 0) + 1;
    store.nudgeMorale(w.id, +12);
    store.emitEvent({
      type: "office",
      workerId: w.id,
      text: `${w.name} kapisti: ${(winner.model ?? "").split("/").pop()}`,
      data: { kind: "promotion", desk: w.desk },
    });
    store.emitEvent({ type: "worker.say", workerId: w.id, text: pick(["ben demistim.", "kolaydi.", "tabii ki."]) });
  }
  // everyone else takes it personally
  for (const t of tasks) {
    if (t.id !== winner.id && t.workerId) store.nudgeMorale(t.workerId, -4);
  }
  store.touch();
  res.json({ ok: true, tasks });
});

// ---- the boss --------------------------------------------------------

/**
 * One call does the whole scene: hire if the floor is empty, pick a desk,
 * walk the boss over, drop the order, optionally wait for the answer.
 */
api.post("/orders", async (req, res) => {
  const b = req.body ?? {};
  const text = String(b.text ?? b.prompt ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });

  let workerId: string | null = b.workerId ?? null;
  if (!workerId && b.model) {
    workerId = store.state.workers.find((w) => w.model === b.model)?.id ?? null;
    if (!workerId) workerId = store.hire({ model: b.model })?.id ?? null;
  }
  if (!workerId && !store.state.workers.length) {
    workerId = store.hire({ model: store.state.settings.defaultModel })?.id ?? null;
  }
  // pick the desk up front so the boss knows where he is walking
  if (!workerId) {
    const free = store.state.workers.filter((w) => w.state === "idle" && !w.currentTaskId);
    workerId = free.sort((a, b2) => a.stats.tasksDone - b2.stats.tasksDone)[0]?.id ?? null;
  }

  const t = store.addTask({
    title: b.title || text.split("\n")[0].slice(0, 60),
    prompt: text,
    system: b.system ?? null,
    workerId,
    createdBy: "boss",
    stage: "backlog",
  });
  // the boss says the actual order; the flavour lines are for empty-handed shouting
  dispatch(t.id, workerId, b.line || (text.length > 150 ? `${text.slice(0, 150)}...` : text) || pick(BOSS_LINES));

  if (b.wait === false) return res.json({ task: t });
  const done = await waitForTask(t.id, Number(b.waitMs) || 180_000);
  res.json({
    task: done,
    output: done?.output ?? "",
    ghost: done?.ghost ?? false,
    worker: store.worker(done?.workerId)?.name ?? null,
  });
});

api.post("/boss/say", (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  store.emitEvent({ type: "boss.say", text, workerId: req.body?.workerId });
  res.json({ ok: true });
});

api.get("/log", (_req, res) => res.json({ log: store.log.slice(-200) }));

/** Make something happen on the floor on purpose. */
api.post("/office", (req, res) => {
  const kind = String(req.body?.kind ?? "");
  if (!happeningKinds().includes(kind)) {
    return res.status(400).json({ error: `unknown happening - try one of: ${happeningKinds().join(", ")}` });
  }
  const ok = fireHappening(kind);
  res.status(ok ? 200 : 409).json({ ok, kinds: happeningKinds() });
});
