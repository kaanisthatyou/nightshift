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

/** How the floor reaches an MCP server. */
export type McpTransport = "stdio" | "http" | "sse";

/**
 * One configured MCP server. `command`/`args`/`env` are for stdio; `url`/`headers`
 * for the two HTTP transports. Secrets live here and never leave the server -
 * the browser only ever sees `McpServerStatus`.
 */
export interface McpServerConfig {
  id: string;
  /** short handle - also the tool namespace, so `fs` gives `fs__read_file` */
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  /** a disabled server is kept but never connected */
  enabled: boolean;
  /** whitelist of tool names; empty means every tool the server offers */
  allow: string[];
  createdAt: number;
}

export interface McpToolInfo {
  serverId: string;
  /** server handle, for display */
  server: string;
  /** the tool's own name, as the server calls it */
  name: string;
  /** what the model sees: `<server>__<name>` */
  qualified: string;
  description: string;
  schema: Record<string, unknown>;
}

/** The redacted, browser-safe view of a configured server. */
export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  online: boolean;
  error: string | null;
  /** command line or url, for display only - never the env or headers */
  target: string;
  toolCount: number;
  tools: McpToolInfo[];
  allow: string[];
  lastCheck: number;
}

/** One tool call a desk made while working a task. */
export interface ToolCall {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  ms: number;
}

export interface Worker {
  id: string;
  name: string;
  title: string;
  model: string;
  /** MCP servers this desk is allowed to reach - empty means it works bare-handed */
  mcpIds: string[];
  /**
   * Qualified tool names (`roblox__script_read`) this desk may use. Empty means
   * every tool its servers offer - which is usually too many: a full Roblox
   * Studio toolbox is ~11k tokens of schema on every single request, and a
   * cheap model does better when handed four tools than twenty-six.
   */
  mcpTools: string[];
  /** which loadout they were hired into, if any */
  presetId: string | null;
  /** role key inside that preset - plan steps route by this */
  role: string | null;
  /** personality key from the temper catalog */
  temper: string | null;
  /** the system prompt this desk carries into every task */
  persona: string | null;
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
  /** the plan this task was cut from, if it came off the whiteboard */
  planId: string | null;
  /** every tool the desk reached for while working this, in order */
  toolCalls: ToolCall[];
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

/** One line on the whiteboard, before it becomes work. */
export interface PlanStep {
  id: string;
  title: string;
  prompt: string;
  /** role key the step wants - resolved to a desk at run time */
  roleKey: string | null;
  /** pinned desk, overrides roleKey */
  workerId: string | null;
  note: string | null;
  /** unticked steps stay on the board when the plan is sent down */
  enabled: boolean;
  /** set once the step has been cut into a task */
  taskId: string | null;
}

export interface Plan {
  id: string;
  title: string;
  /** what you actually typed */
  idea: string;
  summary: string;
  presetId: string | null;
  steps: PlanStep[];
  /** chain: each step feeds the next. split: every step goes out at once. */
  mode: "chain" | "split";
  status: "draft" | "running" | "done" | "failed";
  jobId: string | null;
  createdAt: number;
  /** who drafted it, or "you" when it was written by hand */
  draftedBy: string | null;
  ghost: boolean;
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
    | "plan.new"
    | "plan.run"
    | "tool.call"    // a desk reached for a tool
    | "tool.result"  // and got something back
    | "mcp"          // a server came up, went down, or changed
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
  plans: Plan[];
  gateway: GatewayStatus;
  /** redacted - configs with their secrets stay on the server */
  mcp: McpServerStatus[];
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
    /** the model that drafts plans - worth spending a bit more on */
    plannerModel: string;
    /** master switch: off means no desk gets tools, whatever it was assigned */
    mcpEnabled: boolean;
    /** how many tool rounds a desk may run before it has to answer in words */
    mcpMaxRounds: number;
  };
}

export type ServerMessage =
  | { type: "hello"; state: FloorState; models: ModelInfo[] }
  | { type: "state"; state: FloorState }
  | { type: "event"; event: FloorEvent }
  | { type: "models"; models: ModelInfo[] };
