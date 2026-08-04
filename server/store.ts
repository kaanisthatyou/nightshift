// The floor's memory. One JSON file, one event bus, no database ceremony.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FloorEvent, FloorState, Job, Task, Worker, WorkerState,
} from "../shared/types.ts";
import { makeName, makeTitle } from "./flavor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "floor.json");

export const DESK_COUNT = 8;

function blankState(): FloorState {
  return {
    workers: [],
    tasks: [],
    jobs: [],
    gateway: {
      online: false,
      baseUrl: "http://localhost:20128/v1",
      hasKey: false,
      modelCount: 0,
      lastCheck: 0,
      error: null,
    },
    ledger: {
      costUsd: 0, tokensIn: 0, tokensOut: 0,
      tasksDone: 0, tasksFailed: 0, shiftStartedAt: Date.now(),
    },
    settings: {
      autoAssign: true,
      ghostMode: true,
      maxParallel: 4,
      defaultModel: "auto",
    },
  };
}

export const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

class Store extends EventEmitter {
  state: FloorState = blankState();
  /** rolling log, newest last, capped */
  log: FloorEvent[] = [];
  private saveTimer: NodeJS.Timeout | null = null;

  load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        this.state = { ...blankState(), ...raw, gateway: { ...blankState().gateway, ...(raw.gateway ?? {}) } };
        // nobody survives a restart mid-task
        for (const w of this.state.workers) {
          if (w.state !== "asleep") w.state = "idle";
          w.currentTaskId = null;
        }
        for (const t of this.state.tasks) {
          if (t.stage === "running") { t.stage = "queued"; t.workerId = t.workerId ?? null; }
        }
        // a shift that ended hours ago is over - the clock starts at 22:00 again
        if (Date.now() - this.state.ledger.shiftStartedAt > 6 * 60 * 60 * 1000) {
          this.state.ledger.shiftStartedAt = Date.now();
        }
      } else {
        this.seedCrew();
      }
    } catch (err) {
      console.error("[floor] could not read state, starting clean:", err);
      this.state = blankState();
      this.seedCrew();
    }
  }

  /**
   * First boot: an empty floor is a bad first impression, so three desks are
   * already staffed. They sit on `auto`, which is whatever the gateway decides —
   * no model is claimed here that the gateway has not offered.
   */
  private seedCrew() {
    if (this.state.workers.length) return;
    for (let i = 0; i < 3; i++) this.hire({ model: this.state.settings.defaultModel });
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
      } catch (err) {
        console.error("[floor] save failed:", err);
      }
    }, 400);
  }

  /** Broadcast a moment. The window turns these into animation. */
  emitEvent(e: Omit<FloorEvent, "id" | "ts">) {
    const event: FloorEvent = { id: id("ev"), ts: Date.now(), ...e };
    this.log.push(event);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    this.emit("event", event);
    return event;
  }

  touch() {
    this.emit("state", this.state);
    this.save();
  }

  // ---- workers -------------------------------------------------------

  freeDesk(): number {
    const used = new Set(this.state.workers.map((w) => w.desk));
    for (let i = 0; i < DESK_COUNT; i++) if (!used.has(i)) return i;
    return -1;
  }

  hire(opts: { name?: string; model?: string; title?: string }): Worker | null {
    const desk = this.freeDesk();
    if (desk < 0) return null;
    const model = opts.model || this.state.settings.defaultModel;
    const worker: Worker = {
      id: id("w"),
      name: opts.name || makeName(new Set(this.state.workers.map((w) => w.name))),
      title: opts.title || makeTitle(model),
      model,
      desk,
      seed: Math.floor(Math.random() * 1e9),
      state: "idle",
      morale: 80,
      currentTaskId: null,
      hiredAt: Date.now(),
      stats: { tasksDone: 0, tasksFailed: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, msTotal: 0, streak: 0, wins: 0 },
      saying: null,
    };
    this.state.workers.push(worker);
    this.emitEvent({ type: "worker.hired", workerId: worker.id, text: `${worker.name} clocks in as ${worker.title}` });
    this.touch();
    return worker;
  }

  fire(workerId: string): boolean {
    const i = this.state.workers.findIndex((w) => w.id === workerId);
    if (i < 0) return false;
    const [w] = this.state.workers.splice(i, 1);
    for (const t of this.state.tasks) {
      if (t.workerId === w.id && (t.stage === "queued" || t.stage === "running")) {
        t.workerId = null;
        t.stage = "backlog";
      }
    }
    this.emitEvent({ type: "worker.fired", workerId: w.id, text: `${w.name} packs the desk up` });
    this.touch();
    return true;
  }

  worker(wid: string | null | undefined): Worker | undefined {
    return this.state.workers.find((w) => w.id === wid);
  }

  setWorkerState(wid: string, state: WorkerState, saying?: string | null) {
    const w = this.worker(wid);
    if (!w) return;
    w.state = state;
    if (saying !== undefined) w.saying = saying;
    this.touch();
  }

  nudgeMorale(wid: string, delta: number) {
    const w = this.worker(wid);
    if (!w) return;
    w.morale = Math.max(0, Math.min(100, w.morale + delta));
    this.emitEvent({ type: "worker.mood", workerId: wid, data: { morale: w.morale } });
  }

  // ---- tasks ---------------------------------------------------------

  task(tid: string | null | undefined): Task | undefined {
    return this.state.tasks.find((t) => t.id === tid);
  }

  addTask(opts: Partial<Task> & { title: string; prompt: string }): Task {
    const t: Task = {
      id: id("t"),
      jobId: null,
      stepIndex: 0,
      title: opts.title,
      prompt: opts.prompt,
      system: opts.system ?? null,
      sentPrompt: null,
      stage: opts.stage ?? "backlog",
      workerId: opts.workerId ?? null,
      model: opts.model ?? null,
      createdBy: opts.createdBy ?? "you",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      output: "",
      error: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: 0,
      attempts: 0,
      decision: null,
      ghost: false,
      reviewNote: null,
      modelOverride: null,
      fallbackFrom: null,
      arenaId: null,
      wonArena: false,
      retriesLeft: 0,
      ...("jobId" in opts ? { jobId: opts.jobId ?? null } : {}),
      ...("stepIndex" in opts ? { stepIndex: opts.stepIndex ?? 0 } : {}),
      ...("arenaId" in opts ? { arenaId: opts.arenaId ?? null } : {}),
      ...("retriesLeft" in opts ? { retriesLeft: opts.retriesLeft ?? 0 } : {}),
    };
    this.state.tasks.push(t);
    if (this.state.tasks.length > 300) this.state.tasks.splice(0, this.state.tasks.length - 300);
    this.emitEvent({ type: "task.new", taskId: t.id, text: t.title });
    this.touch();
    return t;
  }

  setStage(tid: string, stage: Task["stage"]) {
    const t = this.task(tid);
    if (!t) return;
    t.stage = stage;
    this.emitEvent({ type: "task.stage", taskId: tid, text: stage, workerId: t.workerId ?? undefined });
    this.touch();
  }

  addJob(title: string, taskIds: string[], kind: Job["kind"] = "pipeline"): Job {
    const job: Job = { id: id("j"), title, createdAt: Date.now(), taskIds, stage: "running", kind };
    this.state.jobs.push(job);
    if (this.state.jobs.length > 60) this.state.jobs.splice(0, this.state.jobs.length - 60);
    this.emitEvent({ type: "job.new", text: title, data: { jobId: job.id, steps: taskIds.length, kind } });
    this.touch();
    return job;
  }

  job(jid: string | null | undefined): Job | undefined {
    return this.state.jobs.find((j) => j.id === jid);
  }
}

export const store = new Store();
