// The gateway. Everything the floor knows about models comes through here.
import type { GatewayStatus, ModelInfo } from "../shared/types.ts";

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
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
}

const FREE_HINTS = [
  ":free", "/free", "free/", "-free", "opencode", "kiro", "auto/best-free",
];

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
      };
    } catch (err: any) {
      this.status = {
        online: false,
        baseUrl: this.config.baseUrl,
        hasKey: Boolean(this.config.apiKey),
        modelCount: this.models.length,
        lastCheck: Date.now(),
        error: err?.message ?? String(err),
      };
    }
    return this.status;
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
   * Streaming chat completion. onChunk gets raw deltas so the floor can watch
   * a worker actually type. Returns totals when the stream closes.
   */
  async chat(opts: {
    model: string;
    prompt: string;
    system?: string | null;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
  }): Promise<ChatResult> {
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
        stream: true,
        stream_options: { include_usage: true },
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 1600,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${body.slice(0, 300) || res.statusText}`);
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
    if (!tokensIn) tokensIn = headerIn || Math.ceil((opts.prompt.length + (opts.system?.length ?? 0)) / 4);
    if (!tokensOut) tokensOut = headerOut || Math.ceil(body.length / 4);

    return {
      text: body,
      tokensIn,
      tokensOut,
      decision,
      model: servedModel,
      ghost: false,
      costUsd: headerCost > 0 ? headerCost : null,
    };
  }
}
