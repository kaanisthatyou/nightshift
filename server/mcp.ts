// The floor's toolbox. Configured MCP servers, the client that talks to them,
// and the translation into the tool schema an OpenAI-shaped gateway expects.
//
// Hand-rolled on purpose: the official SDK drags in two web servers to give us
// three JSON-RPC methods (initialize, tools/list, tools/call). This file is the
// client half of MCP and nothing else.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA_DIR, id, store } from "./store.ts";
import type {
  McpServerConfig, McpServerStatus, McpToolInfo, McpTransport,
} from "../shared/types.ts";

const CONFIG_FILE = path.join(DATA_DIR, "mcp.json");
const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 25_000;

/** Tool names the model sees are `<server>__<tool>` - MCP servers may collide. */
export const NAME_SEP = "__";

type RpcResolver = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * MCP configs are written for Claude Desktop, which expands `%VAR%` on Windows.
 * The Roblox Studio server ships exactly that: `%LOCALAPPDATA%\Roblox\mcp.bat`.
 */
function expandArgs(args: string[]): string[] {
  if (process.platform !== "win32") return args;
  return args.map((a) =>
    a.replace(/%([^%]+)%/g, (whole, key) => process.env[key] ?? process.env[String(key).toUpperCase()] ?? whole));
}

/**
 * `npx`, `uvx` and friends are .cmd shims on Windows and cannot be spawned
 * directly. Route those through cmd.exe - but keep shell:false either way so
 * node still quotes arguments, which matters the moment a path has a space in it.
 */
function winWrap(command: string, args: string[]): [string, string[]] {
  if (process.platform !== "win32") return [command, args];
  const expanded = expandArgs([command])[0];
  if (/\.(exe|com)$/i.test(expanded)) return [expanded, args];
  return ["cmd.exe", ["/d", "/s", "/c", expanded, ...args]];
}

/**
 * One live connection. Subclassed per transport because the framing differs;
 * the request/response bookkeeping is shared.
 */
abstract class McpConnection {
  protected nextId = 1;
  protected pending = new Map<number, RpcResolver>();
  tools: McpToolInfo[] = [];
  closed = false;

  constructor(readonly cfg: McpServerConfig) {}

  protected abstract send(payload: unknown): Promise<void>;
  abstract close(): void;

  /** Feed a decoded JSON-RPC message in from whichever transport read it. */
  protected receive(msg: any) {
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.id !== "number") return; // notification from the server - nothing waiting on it
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(msg.error?.message ?? "mcp error"));
    else waiter.resolve(msg.result);
  }

  /** Kill everything still waiting - the transport died under them. */
  protected failAll(err: Error) {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
  }

  async request(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    if (this.closed) throw new Error(`${this.cfg.name} is not connected`);
    const rid = this.nextId++;
    const payload = { jsonrpc: "2.0", id: rid, method, params: params ?? {} };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`${this.cfg.name}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
    });
    await this.send(payload);
    return result;
  }

  async notify(method: string, params?: unknown) {
    if (this.closed) return;
    await this.send({ jsonrpc: "2.0", method, params: params ?? {} }).catch(() => {});
  }

  /** initialize -> initialized -> tools/list. The whole handshake we need. */
  async handshake() {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "nightshift", version: "0.1.0" },
      },
      CONNECT_TIMEOUT_MS,
    );
    await this.notify("notifications/initialized");
    await this.refreshTools();
  }

  async refreshTools() {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    // servers with many tools paginate; walk it out but do not loop forever
    for (let page = 0; page < 20; page++) {
      const res = await this.request("tools/list", cursor ? { cursor } : {});
      for (const t of res?.tools ?? []) {
        if (!t?.name) continue;
        out.push({
          serverId: this.cfg.id,
          server: this.cfg.name,
          name: t.name,
          qualified: `${this.cfg.name}${NAME_SEP}${t.name}`,
          description: t.description ?? "",
          schema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    this.tools = out;
    return out;
  }
}

/** stdio: newline-delimited JSON-RPC on the child's stdin/stdout. */
class StdioConnection extends McpConnection {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";

  constructor(cfg: McpServerConfig) {
    super(cfg);
    if (!cfg.command) throw new Error(`${cfg.name}: stdio server needs a command`);
    const [cmd, args] = winWrap(cfg.command, expandArgs(cfg.args ?? []));
    this.child = spawn(cmd, args, {
      // the server inherits our env plus its own - most want PATH, some want a token
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // never shell:true - it stops node quoting args, and mcp paths have spaces in them
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.receive(JSON.parse(trimmed));
        } catch {
          /* servers log to stdout sometimes; ignore anything that isn't a frame */
        }
      }
    });
    // stderr is where MCP servers are supposed to log - keep the last of it for the error field
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => {
      this.stderr = (this.stderr + c).slice(-2000);
    });
    this.child.on("exit", (code) => {
      this.closed = true;
      this.failAll(new Error(`${cfg.name} exited (${code})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ""}`));
    });
    this.child.on("error", (e) => {
      this.closed = true;
      this.failAll(new Error(`${cfg.name}: ${e.message}`));
    });
  }

  stderr = "";

  protected async send(payload: unknown) {
    if (this.closed || !this.child.stdin.writable) throw new Error(`${this.cfg.name} is not connected`);
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  close() {
    this.closed = true;
    this.failAll(new Error("closed"));
    this.child.kill();
  }
}

/**
 * Streamable HTTP: every request is a POST. The reply is either plain JSON or an
 * SSE stream carrying the same frames. `mcp-session-id` is echoed back once the
 * server issues one.
 */
class HttpConnection extends McpConnection {
  private sessionId: string | null = null;
  private ac = new AbortController();

  constructor(cfg: McpServerConfig) {
    super(cfg);
    if (!cfg.url) throw new Error(`${cfg.name}: http server needs a url`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  protected async send(payload: any) {
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: this.ac.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${this.cfg.name}: http ${res.status} ${body.slice(0, 200)}`);
    }
    // notifications get 202 and no body
    if (res.status === 202 || !res.body) return;

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) {
      await this.drainSse(res.body);
    } else {
      const json = await res.json().catch(() => null);
      if (Array.isArray(json)) json.forEach((m) => this.receive(m));
      else if (json) this.receive(json);
    }
  }

  /** Read `data:` frames until the stream closes; each one is a JSON-RPC message. */
  private async drainSse(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            this.receive(JSON.parse(raw));
          } catch {
            /* ignore partial or non-json frames */
          }
        }
      }
    }
  }

  close() {
    this.closed = true;
    this.ac.abort();
    this.failAll(new Error("closed"));
  }
}

/** Legacy SSE transport: GET opens the event stream, POST goes to the endpoint it names. */
class SseConnection extends McpConnection {
  private postUrl: string | null = null;
  private ac = new AbortController();
  private ready: Promise<void>;

  constructor(cfg: McpServerConfig) {
    super(cfg);
    if (!cfg.url) throw new Error(`${cfg.name}: sse server needs a url`);
    this.ready = this.open();
  }

  private async open() {
    const res = await fetch(this.cfg.url!, {
      headers: { Accept: "text/event-stream", ...(this.cfg.headers ?? {}) },
      signal: this.ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`${this.cfg.name}: sse ${res.status}`);

    let resolveEndpoint: () => void = () => {};
    const gotEndpoint = new Promise<void>((r) => { resolveEndpoint = r; });

    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            let event = "message";
            const data: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trim());
            }
            const payload = data.join("\n");
            if (!payload) continue;
            if (event === "endpoint") {
              // relative to the stream url
              this.postUrl = new URL(payload, this.cfg.url!).toString();
              resolveEndpoint();
            } else {
              try { this.receive(JSON.parse(payload)); } catch { /* ignore */ }
            }
          }
        }
      } finally {
        this.closed = true;
        this.failAll(new Error(`${this.cfg.name}: sse stream closed`));
      }
    })();

    const timeout = new Promise<void>((_, rej) =>
      setTimeout(() => rej(new Error(`${this.cfg.name}: no sse endpoint event`)), CONNECT_TIMEOUT_MS));
    await Promise.race([gotEndpoint, timeout]);
  }

  protected async send(payload: unknown) {
    await this.ready;
    if (!this.postUrl) throw new Error(`${this.cfg.name}: sse endpoint unknown`);
    const res = await fetch(this.postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.cfg.headers ?? {}) },
      body: JSON.stringify(payload),
      signal: this.ac.signal,
    });
    if (!res.ok) throw new Error(`${this.cfg.name}: post ${res.status}`);
    // replies come back on the event stream, not here
  }

  close() {
    this.closed = true;
    this.ac.abort();
    this.failAll(new Error("closed"));
  }
}

function connect(cfg: McpServerConfig): McpConnection {
  if (cfg.transport === "stdio") return new StdioConnection(cfg);
  if (cfg.transport === "sse") return new SseConnection(cfg);
  return new HttpConnection(cfg);
}

export function describeTarget(cfg: McpServerConfig): string {
  if (cfg.transport === "stdio") return [cfg.command ?? "", ...(cfg.args ?? [])].join(" ").trim();
  return cfg.url ?? "";
}

/** Fill in whatever the caller left out, so the rest of the file can stop guarding. */
export function normaliseConfig(raw: any, existing?: McpServerConfig): McpServerConfig {
  const transport: McpTransport =
    raw?.transport === "stdio" || raw?.transport === "http" || raw?.transport === "sse"
      ? raw.transport
      : existing?.transport ?? (raw?.url ? "http" : "stdio");
  const strMap = (v: any, fallback: Record<string, string>): Record<string, string> => {
    if (!v || typeof v !== "object") return fallback;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  };
  // the handle becomes part of a tool name, so keep it to what models handle well
  const rawName = (raw?.name ?? existing?.name ?? "server").toString();
  const name = rawName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 24) || "server";
  return {
    id: existing?.id ?? raw?.id ?? id("mcp"),
    name,
    transport,
    command: typeof raw?.command === "string" ? raw.command : existing?.command ?? null,
    args: Array.isArray(raw?.args) ? raw.args.map(String) : existing?.args ?? [],
    env: strMap(raw?.env, existing?.env ?? {}),
    url: typeof raw?.url === "string" ? raw.url : existing?.url ?? null,
    headers: strMap(raw?.headers, existing?.headers ?? {}),
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : existing?.enabled ?? true,
    allow: Array.isArray(raw?.allow) ? raw.allow.map(String) : existing?.allow ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
  };
}

/**
 * Read the `{"mcpServers": {...}}` block every MCP client uses - Claude Code,
 * Claude Desktop, Cursor. Lets you paste a config you already have instead of
 * retyping it into the floor.
 */
export function fromClientConfig(raw: any): McpServerConfig[] {
  const block = raw?.mcpServers ?? raw?.servers ?? raw;
  if (!block || typeof block !== "object") return [];
  const out: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries<any>(block)) {
    if (!entry || typeof entry !== "object") continue;
    const transport: McpTransport =
      entry.type === "sse" ? "sse"
        : entry.type === "http" || entry.type === "streamable-http" ? "http"
          : entry.url ? "http" : "stdio";
    out.push(normaliseConfig({
      name,
      transport,
      command: entry.command ?? null,
      args: entry.args ?? [],
      env: entry.env ?? {},
      url: entry.url ?? null,
      headers: entry.headers ?? {},
      enabled: entry.disabled === true ? false : true,
    }));
  }
  return out;
}

class McpManager extends EventEmitter {
  configs: McpServerConfig[] = [];
  private live = new Map<string, McpConnection>();
  private errors = new Map<string, string>();
  private checked = new Map<string, number>();

  load() {
    try {
      if (!fs.existsSync(CONFIG_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const list = Array.isArray(raw?.servers) ? raw.servers : Array.isArray(raw) ? raw : [];
      this.configs = list.map((c: any) => normaliseConfig(c));
    } catch (err: any) {
      console.warn(`  mcp: could not read ${CONFIG_FILE} - ${err?.message ?? err}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ servers: this.configs }, null, 2));
    } catch (err: any) {
      console.warn(`  mcp: could not write ${CONFIG_FILE} - ${err?.message ?? err}`);
    }
  }

  config(sid: string | null | undefined) {
    return this.configs.find((c) => c.id === sid);
  }

  /** Bring one up. Safe to call on an already-live server - it reconnects. */
  async open(sid: string): Promise<McpServerStatus | null> {
    const cfg = this.config(sid);
    if (!cfg) return null;
    this.close(sid);
    if (!cfg.enabled) return this.statusOf(cfg);
    try {
      const conn = connect(cfg);
      await conn.handshake();
      this.live.set(cfg.id, conn);
      this.errors.delete(cfg.id);
      this.emit("change", { id: cfg.id, online: true, toolCount: conn.tools.length });
    } catch (err: any) {
      this.errors.set(cfg.id, err?.message ?? String(err));
      this.emit("change", { id: cfg.id, online: false, error: this.errors.get(cfg.id) });
    }
    this.checked.set(cfg.id, Date.now());
    this.sync();
    return this.statusOf(cfg);
  }

  close(sid: string) {
    const conn = this.live.get(sid);
    if (!conn) return;
    try { conn.close(); } catch { /* already gone */ }
    this.live.delete(sid);
  }

  async openAll() {
    for (const cfg of this.configs) {
      if (cfg.enabled) await this.open(cfg.id);
    }
  }

  closeAll() {
    for (const sid of [...this.live.keys()]) this.close(sid);
  }

  statusOf(cfg: McpServerConfig): McpServerStatus {
    const conn = this.live.get(cfg.id);
    const online = Boolean(conn && !conn.closed);
    return {
      id: cfg.id,
      name: cfg.name,
      transport: cfg.transport,
      enabled: cfg.enabled,
      online,
      error: online ? null : this.errors.get(cfg.id) ?? null,
      target: describeTarget(cfg),
      toolCount: conn?.tools.length ?? 0,
      tools: conn?.tools ?? [],
      allow: cfg.allow,
      lastCheck: this.checked.get(cfg.id) ?? 0,
    };
  }

  /** The whole board, redacted - this is what goes over the socket. */
  statuses(): McpServerStatus[] {
    return this.configs.map((c) => this.statusOf(c));
  }

  /** Push the redacted board onto the floor state so the window sees it. */
  sync() {
    store.state.mcp = this.statuses();
    store.touch();
  }

  /** Tools a given set of servers offers, after the per-server allow list. */
  toolsFor(ids: string[]): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const sid of ids) {
      const cfg = this.config(sid);
      const conn = this.live.get(sid);
      if (!cfg || !cfg.enabled || !conn || conn.closed) continue;
      for (const t of conn.tools) {
        if (cfg.allow.length && !cfg.allow.includes(t.name)) continue;
        out.push(t);
      }
    }
    return out;
  }

  /** Look a qualified name (`fs__read_file`) back up to the tool that owns it. */
  find(qualified: string, ids: string[]): McpToolInfo | undefined {
    return this.toolsFor(ids).find((t) => t.qualified === qualified);
  }

  async call(tool: McpToolInfo, args: Record<string, unknown>): Promise<string> {
    const conn = this.live.get(tool.serverId);
    if (!conn || conn.closed) throw new Error(`${tool.server} is not connected`);
    const res = await conn.request("tools/call", { name: tool.name, arguments: args ?? {} });
    if (res?.isError) throw new Error(flattenContent(res?.content) || "tool reported an error");
    return flattenContent(res?.content) || JSON.stringify(res?.structuredContent ?? res ?? {});
  }
}

/** MCP results are a content array; models want one string. */
function flattenContent(content: any): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "resource" && c.resource?.text) parts.push(String(c.resource.text));
    else if (c.type === "image") parts.push(`[image ${c.mimeType ?? ""}]`);
    else parts.push(JSON.stringify(c));
  }
  return parts.join("\n").trim();
}

/** The OpenAI `tools` array the gateway forwards to the model. */
export function asOpenAiTools(tools: McpToolInfo[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.qualified,
      description: t.description.slice(0, 1024),
      parameters: t.schema ?? { type: "object", properties: {} },
    },
  }));
}

export const mcp = new McpManager();
