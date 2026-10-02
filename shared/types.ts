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

/** One file a desk actually put on your disk. */
export interface FileTouch {
  /** relative to the working folder, forward slashes */
  path: string;
  action: "create" | "write" | "edit";
  bytes: number;
  ts: number;
}

/** The check that decides whether the work is real, and what it said. */
export interface VerifyResult {
  command: string;
  ok: boolean;
  code: number | null;
  output: string;
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
  /** how long this desk may think before it writes; unset follows the floor setting */
  reasoning?: import("./providers.ts").ReasoningLevel | null;
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
  /** times a provider said "not this minute" - a wait, not a failed attempt */
  waits?: number;
  /** which key and model actually served the last round, e.g. `nim#2 z-ai/glm-5.3` */
  decision: string | null;
  /** how many different keys or models carried this one conversation */
  hops?: number;
  /** plan wave this task belongs to - wave 2 waits for wave 1 to land */
  wave?: number;
  ghost: boolean;
  reviewNote: string | null;
  /** set when the desk's own model was unavailable and the route took over */
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

  // ---- build mode ----------------------------------------------------
  /**
   * Absolute path of the working folder. Set means this is a build task: the
   * desk gets the native toolbox and is expected to put files on disk rather
   * than to answer in prose. Null is the text task the floor has always run.
   */
  workspace: string | null;
  /**
   * Files this desk owns, relative to the workspace. A write outside them is
   * refused with the reason, so eight desks can share one folder. `["**"]` is
   * the whole project, which is what a single order gets.
   */
  claims: string[];
  /** what it actually wrote, in order */
  files: FileTouch[];
  /** the command that has to pass before the work counts as done */
  verify: string | null;
  /** every time that command was run, including the failures it repaired from */
  verifyRuns: VerifyResult[];
}

export interface Job {
  id: string;
  title: string;
  createdAt: number;
  taskIds: string[];
  stage: "running" | "done" | "failed";
  /** pipeline: steps feed each other. batch: one list split across desks. waves: batches in order. */
  kind: "pipeline" | "batch" | "waves";
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
  /** files this step owns, relative to the plan's working folder */
  claims: string[];
  /**
   * Which wave the step goes out in. Every step in a wave works at the same
   * time; the next wave starts when the whole of this one has landed.
   */
  wave: number;
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
  /**
   * chain: each step feeds the next. split: every step goes out at once.
   * waves: steps go out together by wave number, a wave at a time.
   */
  mode: "chain" | "split" | "waves";
  status: "draft" | "running" | "done" | "failed";
  jobId: string | null;
  createdAt: number;
  /** who drafted it, or "you" when it was written by hand */
  draftedBy: string | null;
  ghost: boolean;
  /**
   * text: the desks answer in words, which is what the floor has always done.
   * build: the desks get the working folder and write real files into it.
   */
  kind: "text" | "build";
  /** absolute working folder, for a build plan */
  workspace: string | null;
  /** the command every step has to leave passing, e.g. `npm run build` */
  verify: string | null;
  /** starter the floor lays down before any desk starts, e.g. `react-vite` */
  stack?: string | null;
  /** the shared contract every desk on this plan is handed */
  contract?: string | null;
  /** extra packages the planner asked the floor to install with the stack */
  deps?: string[];
}

export interface ModelInfo {
  /** `provider/model`, e.g. `nim/z-ai/glm-5.3` - what a desk sits on */
  id: string;
  /** which configured provider serves it */
  provider?: string;
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

/** One key on one provider: the unit a rate limit is actually counted against. */
export interface LaneStatus {
  /** `nim#1` - never the key itself */
  id: string;
  provider: string;
  /** requests in flight right now */
  inflight: number;
  /** how many it may have in flight - shrinks when the provider pushes back */
  limit: number;
  /** requests sent in the last minute */
  lastMinute: number;
  rpm: number;
  /** epoch ms until which this key is resting after a 429; 0 when it is not */
  coolUntil: number;
  served: number;
  failed: number;
}

/** A provider, as the window is allowed to see it: no keys, just their shape. */
export interface ProviderStatus {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  keyCount: number;
  keyless: boolean;
  online: boolean;
  error: string | null;
  modelCount: number;
  lastCheck: number;
  rpm: number;
  concurrency: number;
  /** extra body fields every request to this provider carries */
  params: Record<string, unknown>;
  lanes: LaneStatus[];
}

/**
 * An ordered pool of models. A desk sitting on a route gets the first model
 * with a free key, and when that one's quota runs out mid-task the very same
 * conversation carries on at the next - that is how several free quotas push
 * one piece of work forward instead of each stalling on its own limit.
 */
export interface RouteInfo {
  id: string;
  name: string;
  models: string[];
}

export interface GatewayStatus {
  /** at least one provider answered with models */
  online: boolean;
  modelCount: number;
  lastCheck: number;
  error: string | null;
  providers: ProviderStatus[];
  routes: RouteInfo[];
}

/**
 * The office itself. Desks are grouped into rooms, each room drawn as its own
 * space on the floor, so a crew of three and a crew of thirty-two both look
 * like somewhere people work.
 */
export type RoomTheme = "night" | "loft" | "lab" | "garden" | "arcade";

export interface RoomConfig {
  id: string;
  name: string;
  /** 1..8 - a room is two rows of four */
  desks: number;
  theme: RoomTheme;
}

export interface OfficeConfig {
  name: string;
  rooms: RoomConfig[];
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
    | "file.write"   // a desk put a file on your disk
    | "shell.run"    // a desk ran a command in the working folder
    | "verify"       // the check that says whether the work is real
    | "mcp"          // a server came up, went down, or changed
    | "gateway"
    | "provider"   // a key rested, a route hopped, a provider came up
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

    // ---- build mode --------------------------------------------------
    /** the folder new build work opens in, remembered between shifts */
    workspaceRoot: string | null;
    /**
     * Rounds a build desk gets. Writing a real file takes a read, a write and
     * a check at minimum, so six - the text-mode ceiling - is nowhere near it.
     */
    buildMaxRounds: number;
    /** off means a build desk gets files but no `run` tool at all */
    shellEnabled: boolean;
    /** extra command heads you have allowed, on top of the built-in list */
    shellExtra: string[];
    /** how many times a desk may be handed its own failing check to repair */
    repairRounds: number;
    /**
     * When a desk's own model runs out of quota, carry the conversation on over
     * the `auto` route instead of waiting it out.
     */
    routerFallback: boolean;
    /** how long models may think before writing, unless a desk says otherwise */
    reasoning: import("./providers.ts").ReasoningLevel;
    /** rooms and desks */
    office: OfficeConfig;
  };
}

export type ServerMessage =
  | { type: "hello"; state: FloorState; models: ModelInfo[] }
  | { type: "state"; state: FloorState }
  | { type: "event"; event: FloorEvent }
  | { type: "models"; models: ModelInfo[] };
