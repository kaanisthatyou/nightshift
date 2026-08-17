// The gateway. Everything the floor knows about models comes through here.
import type { ComboInfo, GatewayStatus, ModelInfo } from "../shared/types.ts";

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
}

/** A tool the model asked for, reassembled from the stream. */
export interface WireToolCall {
  id: string;
  name: string;
  /** raw JSON string as the model wrote it - may not parse */
  arguments: string;
}

export interface ChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  decision: string | null;
  model: string;
  ghost: boolean;
  /** what the gateway itself billed, when it says so - beats our own arithmetic */
  costUsd?: number | null;
  /** set when the model wants tools instead of answering */
  toolCalls: WireToolCall[];
  finishReason: string | null;
}

const FREE_HINTS = [
  ":free", "/free", "free/", "-free", "opencode", "kiro", "auto/best-free",
];

/**
 * A provider said "not this minute". It is not a failure: nothing is wrong with
 * the task, the desk or the model, and counting it as one would burn a retry and
 * a morale bar over a clock. It carries how long to wait.
 */
export class RateLimited extends Error {
  waitMs: number;
  status: number;
  constructor(message: string, waitMs: number, status: number) {
    super(message);
    this.name = "RateLimited";
    this.waitMs = waitMs;
    this.status = status;
  }
}

const MIN_WAIT_MS = 2_000;
const MAX_WAIT_MS = 120_000;

/**
 * Retry-After is seconds or an HTTP date; OmniRoute and the providers behind it
 * also hand back reset headers in seconds, milliseconds or an epoch. Read
 * whichever is there and clamp it to something a shift can actually wait out.
 */
function waitFrom(res: Response): number {
  const clamp = (ms: number) => Math.min(Math.max(ms, MIN_WAIT_MS), MAX_WAIT_MS);

  const after = res.headers.get("retry-after");
  if (after) {
    const secs = Number(after);
    if (Number.isFinite(secs)) return clamp(secs * 1000);
    const when = Date.parse(after);
    if (Number.isFinite(when)) return clamp(when - Date.now());
  }

  for (const key of ["x-ratelimit-reset-requests", "x-ratelimit-reset", "x-omniroute-retry-after"]) {
    const raw = res.headers.get(key);
    if (!raw) continue;
    const n = Number(raw.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    // an epoch, a millisecond count or a second count, in that order of size
    if (n > 1e12) return clamp(n - Date.now());
    if (n > 1e3) return clamp(n);
    return clamp(n * 1000);
  }
  return clamp(15_000); // nobody said - a NIM minute window is the usual case
}

/** 429 always; a 503 that names a rate limit is the same thing wearing a hat. */
function rateLimitOf(res: Response, body: string): RateLimited | null {
  const limited = res.status === 429 || (res.status === 503 && /rate.?limit|too many requests/i.test(body));
  if (!limited) return null;
  return new RateLimited(
    `rate limited (${res.status})${body ? `: ${body.slice(0, 160)}` : ""}`,
    waitFrom(res),
    res.status,
  );
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * OmniRoute mirrors OpenRouter-ish pricing fields when it has them - and a bare
 * OmniRoute (no provider keys) reports none at all. `has` tells the two apart so
 * the floor never labels an unknown price as free.
 */
function readPricing(raw: any): { prompt: number; completion: number; has: boolean } {
  const p = raw?.pricing ?? raw?.cost ?? {};
  const rawPrompt = p.prompt ?? p.input ?? p.prompt_tokens ?? raw?.input_cost_per_token;
  const rawCompletion = p.completion ?? p.output ?? p.completion_tokens ?? raw?.output_cost_per_token;
  const has = rawPrompt !== undefined || rawCompletion !== undefined;
  // pricing is usually usd per token -> normalise to usd per 1M tokens
  const scale = (x: number) => (x > 0 && x < 0.01 ? x * 1_000_000 : x);
  return { prompt: scale(num(rawPrompt)), completion: scale(num(rawCompletion)), has };
}

export function normaliseModel(raw: any): ModelInfo {
  const id: string = raw?.id ?? raw?.name ?? "unknown";
  const { prompt, completion, has } = readPricing(raw);
  const lower = id.toLowerCase();
  const flaggedFree =
    raw?.free === true ||
    raw?.is_free === true ||
    FREE_HINTS.some((h) => lower.includes(h));
  const free = flaggedFree || (has && prompt === 0 && completion === 0);
  return {
    id,
    owned_by: raw?.owned_by ?? raw?.provider ?? undefined,
    free,
    unpriced: !free && !has,
    promptCost: prompt,
    completionCost: completion,
    context: raw?.context_length ?? raw?.context ?? raw?.max_context_tokens ?? undefined,
    label: id.split("/").pop() ?? id,
  };
}

export class Gateway {
  config: GatewayConfig;
  models: ModelInfo[] = [];
  status: GatewayStatus;
  /** null until asked; kept here so a refresh cannot wipe what combos() found */
  comboList: ComboInfo[] | null = null;
  activeCombo: string | null = null;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.status = {
      online: false,
      baseUrl: config.baseUrl,
      hasKey: Boolean(config.apiKey),
      modelCount: 0,
      lastCheck: 0,
      error: null,
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  setConfig(next: Partial<GatewayConfig>) {
    this.config = { ...this.config, ...next };
    this.status.baseUrl = this.config.baseUrl;
    this.status.hasKey = Boolean(this.config.apiKey);
  }

  /** Poll /v1/models: it is both the health check and the model catalog. */
  async refresh(): Promise<GatewayStatus> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/models`;
    try {
      const ctl = AbortSignal.timeout(8000);
      const res = await fetch(url, { headers: this.headers(), signal: ctl });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 160)}` : ""}`);
      }
      const json: any = await res.json();
      const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const rank = (m: ModelInfo) => (m.free ? 0 : m.unpriced ? 1 : 2);
      this.models = list.map(normaliseModel).sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return a.id.localeCompare(b.id);
      });
      this.status = {
        online: true,
        baseUrl: this.config.baseUrl,
        hasKey: Boolean(this.config.apiKey),
        modelCount: this.models.length,
        lastCheck: Date.now(),
        error: null,
        combos: this.comboList,
        activeCombo: this.activeCombo,
      };
    } catch (err: any) {
      this.status = {
        online: false,
        baseUrl: this.config.baseUrl,
        hasKey: Boolean(this.config.apiKey),
        modelCount: this.models.length,
        lastCheck: Date.now(),
        error: err?.message ?? String(err),
        combos: this.comboList,
        activeCombo: this.activeCombo,
      };
    }
    return this.status;
  }

  /** The admin API sits at the gateway root; the OpenAI surface is the /v1 under it. */
  private root(): string {
    return this.config.baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
  }

  /**
   * OmniRoute's routing combos, and which one is live. A combo spreads requests
   * across a pool of models, so a floor of eight desks stops being eight racers
   * for one provider's per-minute quota. Anything that is not an OmniRoute
   * simply has no such endpoint - that is not an error, just an empty toolbox.
   */
  async combos(): Promise<{ combos: ComboInfo[]; active: string | null }> {
    const ask = async (path: string) => {
      const res = await fetch(`${this.root()}${path}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? await res.json().catch(() => null) : null;
    };

    const [list, settings] = await Promise.all([
      ask("/api/combos").catch(() => null),
      ask("/api/settings").catch(() => null),
    ]);

    const active: string | null = (settings as any)?.activeCombo ?? null;
    const raw: any[] = Array.isArray(list) ? list : ((list as any)?.combos ?? []);
    const combos = raw.map((c: any): ComboInfo => {
      const name = String(c?.name ?? c?.id ?? "?");
      const targets = c?.targets ?? c?.steps ?? c?.models;
      return {
        id: String(c?.id ?? name),
        name,
        strategy: String(c?.strategy ?? "priority"),
        enabled: c?.enabled !== false,
        active: active != null && (name === active || String(c?.id) === active),
        targets: Array.isArray(targets) ? targets.length : null,
      };
    });
    this.comboList = combos;
    this.activeCombo = active;
    this.status.combos = combos;
    this.status.activeCombo = active;
    return { combos, active };
  }

  /** Switch the live combo. It is a gateway-wide setting, not a per-desk one. */
  async useCombo(name: string): Promise<void> {
    const res = await fetch(`${this.root()}/api/settings`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ activeCombo: name }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${body.slice(0, 200) || res.statusText}`);
    }
  }

  priceOf(model: string): ModelInfo | undefined {
    return this.models.find((m) => m.id === model);
  }

  costFor(model: string, tokensIn: number, tokensOut: number): number {
    const info = this.priceOf(model);
    if (!info) return 0;
    return (tokensIn / 1e6) * info.promptCost + (tokensOut / 1e6) * info.completionCost;
  }

  /**
   * One-shot, no streaming. Used by the planner, which wants an answer rather
   * than a performance. Returns the raw text.
   */
  async complete(opts: {
    model: string;
    prompt: string;
    system?: string | null;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; model: string; tokensIn: number; tokensOut: number; costUsd: number }> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const messages: any[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt });

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.5,
        max_tokens: opts.maxTokens ?? 2200,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw rateLimitOf(res, body) ?? new Error(`gateway ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    }
    const json: any = await res.json();
    const choice = json?.choices?.[0]?.message ?? {};
    const text: string = (choice.content ?? choice.reasoning_content ?? choice.reasoning ?? "").toString();
    const tokensIn = num(json?.usage?.prompt_tokens) || Math.ceil(opts.prompt.length / 4);
    const tokensOut = num(json?.usage?.completion_tokens) || Math.ceil(text.length / 4);
    const served = json?.model ?? opts.model;
    const headerCost = num(res.headers.get("x-omniroute-response-cost"));
    return {
      text,
      model: served,
      tokensIn,
      tokensOut,
      costUsd: headerCost > 0 ? headerCost : this.costFor(served, tokensIn, tokensOut),
    };
  }

  /**
   * Streaming chat completion. onChunk gets raw deltas so the floor can watch
   * a worker actually type. Returns totals when the stream closes.
   */
  async chat(opts: {
    model: string;
    /** either a bare prompt, or the whole conversation when a tool loop is running */
    prompt?: string;
    messages?: any[];
    system?: string | null;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
    /** OpenAI-shaped tool definitions; omitted entirely when the desk has none */
    tools?: unknown[];
  }): Promise<ChatResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const messages: any[] = [];
    if (opts.messages) {
      messages.push(...opts.messages);
    } else {
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: opts.prompt ?? "" });
    }

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 1600,
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw rateLimitOf(res, body) ?? new Error(`gateway ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    }

    const decision =
      res.headers.get("x-omniroute-decision") ??
      res.headers.get("x-omniroute-provider") ??
      res.headers.get("x-provider") ??
      null;
    const headerCost = num(res.headers.get("x-omniroute-response-cost"));
    const headerIn = num(res.headers.get("x-omniroute-tokens-in"));
    const headerOut = num(res.headers.get("x-omniroute-tokens-out"));

    let text = "";
    let reasoning = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let servedModel = res.headers.get("x-omniroute-model") || opts.model;
    let finishReason: string | null = null;
    // tool calls arrive as fragments keyed by index; arguments are streamed a few chars at a time
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            text += delta;
            opts.onChunk?.(delta);
          }
          // reasoning models spend their first tokens thinking out loud
          const think = json?.choices?.[0]?.delta?.reasoning_content ?? json?.choices?.[0]?.delta?.reasoning;
          if (typeof think === "string" && think) {
            reasoning += think;
            opts.onChunk?.(think);
          }
          for (const tc of json?.choices?.[0]?.delta?.tool_calls ?? []) {
            const idx = typeof tc.index === "number" ? tc.index : toolAcc.size;
            const slot = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") slot.arguments += tc.function.arguments;
            toolAcc.set(idx, slot);
          }
          // some gateways only ever send the finished call, not deltas
          for (const tc of json?.choices?.[0]?.message?.tool_calls ?? []) {
            const idx = toolAcc.size;
            toolAcc.set(idx, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
            });
          }
          if (json?.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
          if (json?.model) servedModel = json.model;
          if (json?.usage) {
            tokensIn = json.usage.prompt_tokens ?? tokensIn;
            tokensOut = json.usage.completion_tokens ?? tokensOut;
          }
        } catch {
          /* partial frame, ignore */
        }
      }
    }

    // a reasoning model that spent its whole budget thinking still said something
    const body = text.trim() || reasoning.trim();

    // Usage can arrive in the stream, in the headers, or not at all - fall back in that order.
    // messages is the real payload whether it came from a prompt or a tool loop
    if (!tokensIn) tokensIn = headerIn || Math.ceil(JSON.stringify(messages).length / 4);
    if (!tokensOut) tokensOut = headerOut || Math.ceil(body.length / 4);

    const toolCalls: WireToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v], i) => ({ id: v.id || `call_${i}`, name: v.name, arguments: v.arguments }))
      .filter((c) => c.name);

    return {
      text: body,
      tokensIn,
      tokensOut,
      decision,
      model: servedModel,
      ghost: false,
      costUsd: headerCost > 0 ? headerCost : null,
      toolCalls,
      finishReason,
    };
  }
}
