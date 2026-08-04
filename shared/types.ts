// Shared vocabulary between the floor (server) and the window (web).

export type WorkerState =
  | "idle"
  | "walking"
  | "thinking"
  | "typing"
  | "delivering"
  | "burnt"
  | "coffee"
  | "asleep";

export interface WorkerStats {
  tasksDone: number;
  tasksFailed: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  msTotal: number;
  streak: number;
  /** head-to-head wins in the arena */
  wins?: number;
}

export interface Worker {
  id: string;
  name: string;
  title: string;
  model: string;
  /** desk index on the floor, 0-based */
  desk: number;
  /** deterministic seed for the pixel sprite generator */
  seed: number;
  state: WorkerState;
  morale: number; // 0..100
  currentTaskId: string | null;
  hiredAt: number;
  stats: WorkerStats;
  /** last thing they said, for the bubble */
  saying: string | null;
}

export type TaskStage =
  | "backlog"
  | "queued"
  | "running"
  | "review"
  | "done"
  | "rejected"
  | "failed";

export interface Task {
  id: string;
  jobId: string | null;
  stepIndex: number;
  title: string;
  prompt: string;
  system: string | null;
  /** resolved prompt actually sent (after {{input}} substitution) */
  sentPrompt: string | null;
  stage: TaskStage;
  workerId: string | null;
  model: string | null;
  createdBy: "boss" | "you" | "pipeline";
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  output: string;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  /** X-OmniRoute-Decision, i.e. which provider actually served it */
  decision: string | null;
  ghost: boolean;
  reviewNote: string | null;
  /** set when the desk's own model was unavailable and the gateway's router took over */
  modelOverride: string | null;
  fallbackFrom: string | null;
  /** same prompt, several desks, one winner */
  arenaId: string | null;
  wonArena: boolean;
  /** how many more times this may be re-thrown at the floor after a failure */
  retriesLeft: number;
}

export interface Job {
  id: string;
  title: string;
  createdAt: number;
  taskIds: string[];
  stage: "running" | "done" | "failed";
  /** pipeline: steps feed each other. batch: one list split across desks. */
  kind: "pipeline" | "batch";
}

export interface ModelInfo {
  id: string;
  owned_by?: string;
  /** explicitly free, or priced at zero */
  free: boolean;
  /** the gateway reported no price at all - do not pretend that means free */
  unpriced: boolean;
  promptCost: number; // usd per 1M tokens
  completionCost: number;
  context?: number;
  label: string;
}

export interface GatewayStatus {
  online: boolean;
  baseUrl: string;
  hasKey: boolean;
  modelCount: number;
  lastCheck: number;
  error: string | null;
  version?: string;
}

export interface FloorEvent {
  id: string;
  ts: number;
  type:
    | "boss.order"      // boss walks to a desk and speaks
    | "boss.say"        // boss speaks to the room
    | "worker.start"
    | "worker.chunk"
    | "worker.done"
    | "worker.fail"
    | "worker.say"
    | "worker.hired"
    | "worker.fired"
    | "worker.mood"
    | "task.new"
    | "task.stage"
    | "job.new"
    | "job.done"
    | "gateway"
    | "office"    // something happened on the floor that isn't work
    | "system";
  workerId?: string;
  taskId?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface FloorState {
  workers: Worker[];
  tasks: Task[];
  jobs: Job[];
  gateway: GatewayStatus;
  ledger: {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    tasksDone: number;
    tasksFailed: number;
    shiftStartedAt: number;
  };
  settings: {
    autoAssign: boolean;
    ghostMode: boolean; // run fake workers when the gateway is down
    maxParallel: number;
    defaultModel: string;
  };
}

export type ServerMessage =
  | { type: "hello"; state: FloorState; models: ModelInfo[] }
  | { type: "state"; state: FloorState }
  | { type: "event"; event: FloorEvent }
  | { type: "models"; models: ModelInfo[] };
