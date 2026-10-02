// The floor's own switchboard. No gateway in between: every provider is an
// OpenAI-compatible base URL with one or more keys, and every key is a lane with
// its own clock. A request goes to whichever lane serving that model is free
// right now - and because a desk's conversation is plain OpenAI messages, the
// next round of the same task can land on a different key, or a different
// provider on the same route, without the desk ever noticing.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.ts";
import { PROVIDER_PRESETS, guessProvider, providerPreset, type ReasoningLevel } from "../shared/providers.ts";
import type { GatewayStatus, LaneStatus, ModelInfo, ProviderStatus, RouteInfo } from "../shared/types.ts";

// ---- what a caller gets back ------------------------------------------

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
  /** which lane and model served it, e.g. `nim#2 z-ai/glm-5.3` */
  decision: string | null;
  model: string;
  ghost: boolean;
  costUsd?: number | null;
  /** set when the model wants tools instead of answering */
  toolCalls: WireToolCall[];
  finishReason: string | null;
  /** how many lanes were tried before one answered */
  hops?: number;
}

/**
 * A provider said "not this minute", and so did every other lane that could
 * have served the request. It is not a failure: it carries how long to wait.
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

/** The lane answered, but with something that says this lane is the problem. */
class LaneError extends Error {
  kind: "limit" | "auth" | "model" | "flaky" | "request";
  status: number;
  waitMs: number;
  constructor(kind: LaneError["kind"], message: string, status = 0, waitMs = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.waitMs = waitMs;
  }
}

// ---- configuration on disk --------------------------------------------

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** secrets. Never leave the server. */
  keys: string[];
  enabled: boolean;
  rpm: number;
  concurrency: number;
  keyless: boolean;
  /** extra body fields for every request, e.g. `{ "top_p": 0.9 }` */
  params: Record<string, unknown>;
  /** models to offer even if /models does not list them */
  models: string[];
}

interface RouterFile {
  providers: ProviderConfig[];
  routes: RouteInfo[];
}

const FILE = path.join(DATA_DIR, "providers.json");

const MIN_WAIT_MS = 2_000;
const MAX_WAIT_MS = 120_000;

/** Ids that are listed by /models but cannot hold a conversation. */
const NOT_CHAT =
  /embed|whisper|tts|transcribe|guard|safety|reward|rerank|retriever|parse|clip|vila|deplot|kosmos|fuyu|neva|veo|lyria|imagen|image|banana|orpheus|calibration|detector|translate|cosmos|robotics|aqa|computer-use|deep-research|compound|prompt-guard|allam|recurrentgemma|starcoder|codegemma|zamba|gemma-2b|nemoretriever/i;

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function waitFrom(res: Response): number {
  const clamp = (ms: number) => Math.min(Math.max(ms, MIN_WAIT_MS), MAX_WAIT_MS);
  const after = res.headers.get("retry-after");
  if (after) {
    const secs = Number(after);
    if (Number.isFinite(secs)) return clamp(secs * 1000);
    const when = Date.parse(after);
    if (Number.isFinite(when)) return clamp(when - Date.now());
  }
  for (const key of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
    const raw = res.headers.get(key);
    if (!raw) continue;
    // groq writes durations like `2m59.56s` or `7.66s`
    const dur = raw.match(/^(?:(\d+)m)?(?:([\d.]+)s)?$/);
    if (dur && (dur[1] || dur[2])) return clamp((num(dur[1]) * 60 + num(dur[2])) * 1000);
    const n = Number(raw.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n > 1e12) return clamp(n - Date.now());
    if (n > 1e3) return clamp(n);
    return clamp(n * 1000);
  }
  return clamp(15_000);
}

function readPricing(raw: any): { prompt: number; completion: number; has: boolean } {
  const p = raw?.pricing ?? raw?.cost ?? {};
  const rawPrompt = p.prompt ?? p.input ?? raw?.input_cost_per_token;
  const rawCompletion = p.completion ?? p.output ?? raw?.output_cost_per_token;
  const has = rawPrompt !== undefined || rawCompletion !== undefined;
  const scale = (x: number) => (x > 0 && x < 0.01 ? x * 1_000_000 : x);
  return { prompt: scale(num(rawPrompt)), completion: scale(num(rawCompletion)), has };
}

/** Free providers are free; the rest say what they cost or are left unpriced. */
const FREE_PROVIDERS = new Set(["nim", "groq", "gemini", "cerebras", "ollama", "lmstudio"]);

export function normaliseModel(raw: any, provider = ""): ModelInfo {
  const bare = String(raw?.id ?? raw?.name ?? "unknown").replace(/^models\//, "");
  const id = provider ? `${provider}/${bare}` : bare;
  const { prompt, completion, has } = readPricing(raw);
  const free = FREE_PROVIDERS.has(provider) || raw?.free === true || /:free$/.test(bare) || (has && prompt === 0 && completion === 0);
  return {
    id,
    provider: provider || undefined,
    owned_by: raw?.owned_by ?? undefined,
    free,
    unpriced: !free && !has,
    promptCost: prompt,
    completionCost: completion,
    context: raw?.context_length ?? raw?.context_window ?? undefined,
    label: bare.split("/").pop() ?? bare,
  };
}

// ---- a lane: one key, one clock ---------------------------------------

class Lane {
  id: string;
  provider: ProviderConfig;
  key: string;
  inflight = 0;
  limit: number;
  stamps: number[] = [];
  coolUntil = 0;
  served = 0;
  failed = 0;
  private calm = 0;

  constructor(provider: ProviderConfig, key: string, index: number) {
    this.provider = provider;
    this.key = key;
    this.id = `${provider.id}#${index + 1}`;
    this.limit = Math.max(1, provider.concurrency || 2);
  }

  private trim(now: number) {
    while (this.stamps.length && now - this.stamps[0] > 60_000) this.stamps.shift();
  }

  /** 0 when this lane can take a request right now, otherwise how long until it can. */
  waitFor(now: number): number {
    if (this.coolUntil > now) return this.coolUntil - now;
    this.trim(now);
    const rpm = this.provider.rpm;
    if (rpm > 0 && this.stamps.length >= rpm) return 60_000 - (now - this.stamps[0]) + 50;
    if (this.inflight >= this.limit) return 800; // someone will finish; look again shortly
    return 0;
  }

  take(now: number) {
    this.inflight += 1;
    this.stamps.push(now);
  }

  release(ok: boolean) {
    this.inflight = Math.max(0, this.inflight - 1);
    if (ok) {
      this.served += 1;
      // the provider stopped pushing back: give the concurrency back, slowly
      if (++this.calm >= 4 && this.limit < this.provider.concurrency) {
        this.limit += 1;
        this.calm = 0;
      }
    } else {
      this.failed += 1;
      this.calm = 0;
    }
  }

  /** A 429. Rest for as long as it said, and ask for less at once afterwards. */
  rest(ms: number) {
    this.coolUntil = Date.now() + ms;
    this.limit = Math.max(1, this.limit - 1);
    this.calm = 0;
  }

  status(): LaneStatus {
    const now = Date.now();
    this.trim(now);
    return {
      id: this.id,
      provider: this.provider.id,
      inflight: this.inflight,
      limit: this.limit,
      lastMinute: this.stamps.length,
      rpm: this.provider.rpm,
      coolUntil: this.coolUntil > now ? this.coolUntil : 0,
      served: this.served,
      failed: this.failed,
    };
  }
}

// ---- the router --------------------------------------------------------

export interface ChatOptions {
  model: string;
  prompt?: string;
  messages?: any[];
  system?: string | null;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  tools?: unknown[];
  reasoning?: ReasoningLevel | null;
  /** longest the stream may go silent before the lane counts as hung */
  idleMs?: number;
  /** called when the request moves to another lane, so the floor can say so */
  onHop?: (from: string, to: string, why: string) => void;
  /**
   * Called when every lane that could serve this is resting and the request is
   * waiting for the soonest one. The conversation is kept - waiting here is the
   * whole point, because giving up would throw away every round so far.
   */
  onWait?: (ms: number) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });

export class ModelRouter {
  providers: ProviderConfig[] = [];
  routes: RouteInfo[] = [];
  models: ModelInfo[] = [];
  status: GatewayStatus = { online: false, modelCount: 0, lastCheck: 0, error: null, providers: [], routes: [] };
  /** keys that came from the environment - used, never written to disk */
  private envKeys = new Map<string, string[]>();
  private lanes = new Map<string, Lane[]>();
  private providerErrors = new Map<string, { error: string | null; online: boolean; count: number; at: number }>();
  /** `provider/model` -> until when it is being avoided, and why */
  private sick = new Map<string, { until: number; why: string }>();
  /** default reasoning level; the store owns the setting, this is just what it is right now */
  reasoning: ReasoningLevel = "low";
  /** carry a desk's conversation over the auto route when its own model is out */
  fallback = true;

  // ---- loading and saving ----------------------------------------------

  load() {
    let file: Partial<RouterFile> = {};
    try {
      if (fs.existsSync(FILE)) file = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch (err) {
      console.error("[router] providers.json unreadable, starting without it:", err);
    }
    this.providers = (Array.isArray(file.providers) ? file.providers : []).map((p) => this.normalise(p));
    this.routes = Array.isArray(file.routes) ? file.routes.map((r) => this.normaliseRoute(r)) : [];

    // keys in the environment are the zero-config path: NVIDIA_API_KEY=... npm start
    for (const preset of PROVIDER_PRESETS) {
      const keys = preset.env
        .flatMap((name) => String(process.env[name] ?? "").split(/[,\s]+/))
        .map((k) => k.trim())
        .filter(Boolean);
      if (!keys.length) continue;
      this.envKeys.set(preset.id, keys);
      if (!this.provider(preset.id)) this.providers.push(this.fromPreset(preset.id));
    }
    // and a plain keys file, one per line, for everybody who prefers that
    this.importKeysFile(path.join(DATA_DIR, "keys.txt"), false);
    if (!this.routes.some((r) => r.id === "auto")) this.routes.unshift({ id: "auto", name: "auto", models: [] });
    this.rebuildLanes();
  }

  save() {
    const body: RouterFile = { providers: this.providers, routes: this.routes };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
    } catch (err) {
      console.error("[router] could not save providers.json:", err);
    }
  }

  private normalise(raw: any): ProviderConfig {
    const preset = providerPreset(raw?.id);
    return {
      id: String(raw?.id ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") || `custom${this.providers.length + 1}`,
      name: String(raw?.name ?? preset?.name ?? raw?.id ?? "custom"),
      baseUrl: String(raw?.baseUrl ?? preset?.baseUrl ?? "").replace(/\/+$/, ""),
      keys: Array.isArray(raw?.keys) ? raw.keys.map((k: unknown) => String(k).trim()).filter(Boolean) : [],
      enabled: raw?.enabled !== false,
      rpm: Number.isFinite(raw?.rpm) ? Math.max(0, Number(raw.rpm)) : preset?.rpm ?? 30,
      concurrency: Number.isFinite(raw?.concurrency) ? Math.max(1, Number(raw.concurrency)) : preset?.concurrency ?? 2,
      keyless: Boolean(raw?.keyless ?? preset?.keyless),
      params: raw?.params && typeof raw.params === "object" ? raw.params : {},
      models: Array.isArray(raw?.models) ? raw.models.map(String) : [],
    };
  }

  private normaliseRoute(raw: any): RouteInfo {
    const idv = String(raw?.id ?? raw?.name ?? "route").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    return {
      id: idv,
      name: String(raw?.name ?? idv),
      models: Array.isArray(raw?.models) ? raw.models.map(String).filter(Boolean) : [],
    };
  }

  private fromPreset(id: string): ProviderConfig {
    return this.normalise({ id });
  }

  provider(id: string | null | undefined): ProviderConfig | undefined {
    return this.providers.find((p) => p.id === id);
  }

  private keysOf(p: ProviderConfig): string[] {
    const all = [...p.keys, ...(this.envKeys.get(p.id) ?? [])];
    const unique = [...new Set(all)];
    return unique.length ? unique : p.keyless ? [""] : [];
  }

  private rebuildLanes() {
    const next = new Map<string, Lane[]>();
    for (const p of this.providers) {
      const old = this.lanes.get(p.id) ?? [];
      const lanes = this.keysOf(p).map((key, i) => {
        // a lane that is resting keeps resting through a config change
        const kept = old.find((l) => l.key === key);
        if (kept) {
          kept.provider = p;
          kept.id = `${p.id}#${i + 1}`;
          return kept;
        }
        return new Lane(p, key, i);
      });
      next.set(p.id, lanes);
    }
    this.lanes = next;
  }

  /**
   * `nvapi-... ` on a line, or `groq = gsk_...`, or `nim: nvapi-... | label`.
   * Returns what it added. Keys already known are skipped quietly.
   */
  importKeys(text: string): { added: { provider: string; count: number }[]; skipped: number } {
    const counts = new Map<string, number>();
    let skipped = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/(^|\s)(#|\/\/).*$/, "").trim();
      if (!line) continue;
      const [head] = line.split("|");
      const parts = head.split(/\s*[=:\t]\s*|\s+/).filter(Boolean);
      let providerId: string | null = null;
      let key: string | null = null;
      let baseUrl: string | null = null;
      if (parts.length === 1) {
        key = parts[0];
        providerId = guessProvider(key)?.id ?? null;
      } else {
        const name = parts[0].toLowerCase();
        key = parts.slice(1).join("");
        providerId = providerPreset(name)?.id ?? (name === "nvidia" ? "nim" : name === "google" ? "gemini" : name);
        const url = line.split("|").map((s) => s.trim()).find((s) => /^https?:\/\//.test(s));
        if (url) baseUrl = url;
      }
      if (!key || !providerId) {
        skipped += 1;
        continue;
      }
      let p = this.provider(providerId);
      if (!p) {
        if (!providerPreset(providerId) && !baseUrl) {
          skipped += 1;
          continue;
        }
        p = this.normalise({ id: providerId, baseUrl: baseUrl ?? undefined });
        this.providers.push(p);
      }
      if (p.keys.includes(key)) continue;
      p.keys.push(key);
      counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
    this.rebuildLanes();
    return { added: [...counts].map(([provider, count]) => ({ provider, count })), skipped };
  }

  private importKeysFile(file: string, persist: boolean) {
    try {
      if (!fs.existsSync(file)) return;
      const res = this.importKeys(fs.readFileSync(file, "utf8"));
      if (persist && res.added.length) this.save();
    } catch {
      /* a keys file is a convenience, never a reason not to boot */
    }
  }

  upsertProvider(raw: any): ProviderConfig {
    const incoming = this.normalise(raw);
    const cur = this.provider(incoming.id);
    if (cur) {
      // keys are only replaced when a list was actually sent - editing the rpm
      // must not wipe the keys the window never had in the first place
      const keys = Array.isArray(raw?.keys) ? incoming.keys : cur.keys;
      const extra = typeof raw?.key === "string" && raw.key.trim() ? [raw.key.trim()] : [];
      Object.assign(cur, {
        ...incoming,
        keys: [...new Set([...keys, ...extra])],
        models: Array.isArray(raw?.models) ? incoming.models : cur.models,
        params: raw?.params ? incoming.params : cur.params,
      });
      this.rebuildLanes();
      this.save();
      return cur;
    }
    if (typeof raw?.key === "string" && raw.key.trim()) incoming.keys.push(raw.key.trim());
    if (!incoming.baseUrl) throw new Error("a provider needs a baseUrl");
    this.providers.push(incoming);
    this.rebuildLanes();
    this.save();
    return incoming;
  }

  removeProvider(id: string): boolean {
    const i = this.providers.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.providers.splice(i, 1);
    this.envKeys.delete(id);
    this.rebuildLanes();
    this.models = this.models.filter((m) => m.provider !== id);
    this.save();
    return true;
  }

  setRoute(raw: any): RouteInfo {
    const route = this.normaliseRoute(raw);
    const i = this.routes.findIndex((r) => r.id === route.id);
    if (i >= 0) this.routes[i] = route;
    else this.routes.push(route);
    this.save();
    this.status = this.snapshot();
    return route;
  }

  removeRoute(id: string): boolean {
    if (id === "auto") {
      const auto = this.routes.find((r) => r.id === "auto");
      if (auto) auto.models = [];
      this.save();
      return true;
    }
    const i = this.routes.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.routes.splice(i, 1);
    this.save();
    return true;
  }

  // ---- the catalog -------------------------------------------------------

  /** Ask every enabled provider what it serves. That is also the health check. */
  async refresh(): Promise<GatewayStatus> {
    const all: ModelInfo[] = [];
    await Promise.all(
      this.providers.map(async (p) => {
        const lanes = this.lanes.get(p.id) ?? [];
        if (!p.enabled || !lanes.length) {
          this.providerErrors.set(p.id, {
            online: false,
            error: p.enabled ? "no key" : "disabled",
            count: 0,
            at: Date.now(),
          });
          return;
        }
        const lane = lanes[0];
        try {
          const res = await fetch(`${p.baseUrl}/models`, {
            headers: this.headers(lane),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`${res.status}${body ? ` ${body.slice(0, 120)}` : ""}`);
          }
          const json: any = await res.json();
          const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
          const seen = new Set<string>();
          for (const raw of list) {
            const m = normaliseModel(raw, p.id);
            if (NOT_CHAT.test(m.id) || seen.has(m.id)) continue;
            seen.add(m.id);
            all.push(m);
          }
          for (const pinned of p.models) {
            const idv = `${p.id}/${pinned}`;
            if (!seen.has(idv)) all.push(normaliseModel({ id: pinned }, p.id));
          }
          this.providerErrors.set(p.id, { online: true, error: null, count: seen.size, at: Date.now() });
        } catch (err: any) {
          // a provider that will not list is not necessarily one that will not
          // serve - keep the pinned models and whatever it listed last time
          const kept = this.models.filter((m) => m.provider === p.id);
          all.push(...kept);
          for (const pinned of p.models) {
            if (!kept.some((m) => m.id === `${p.id}/${pinned}`)) all.push(normaliseModel({ id: pinned }, p.id));
          }
          this.providerErrors.set(p.id, {
            online: kept.length > 0,
            error: err?.message ?? String(err),
            count: kept.length,
            at: Date.now(),
          });
        }
      }),
    );
    const suggested = new Set(PROVIDER_PRESETS.flatMap((p) => p.suggested.map((s) => `${p.id}/${s}`)));
    this.models = all.sort((a, b) => {
      const sa = suggested.has(a.id) ? 0 : 1;
      const sb = suggested.has(b.id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
    this.status = this.snapshot();
    return this.status;
  }

  snapshot(): GatewayStatus {
    const providers: ProviderStatus[] = this.providers.map((p) => {
      const e = this.providerErrors.get(p.id);
      const lanes = this.lanes.get(p.id) ?? [];
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        keyCount: p.keyless ? 0 : lanes.length,
        keyless: p.keyless,
        online: Boolean(e?.online),
        error: e?.error ?? null,
        modelCount: this.models.filter((m) => m.provider === p.id).length,
        lastCheck: e?.at ?? 0,
        rpm: p.rpm,
        concurrency: p.concurrency,
        params: p.params,
        lanes: lanes.map((l) => l.status()),
      };
    });
    const online = providers.some((p) => p.online && p.enabled);
    const firstError = providers.find((p) => p.error)?.error ?? null;
    return {
      online,
      modelCount: this.models.length,
      lastCheck: Date.now(),
      error: online ? null : providers.length ? firstError : "no provider configured - add a key",
      providers,
      routes: this.routes.map((r) => ({ ...r, models: [...r.models] })),
    };
  }

  priceOf(model: string): ModelInfo | undefined {
    return this.models.find((m) => m.id === model);
  }

  costFor(model: string, tokensIn: number, tokensOut: number): number {
    const info = this.priceOf(model);
    if (!info) return 0;
    return (tokensIn / 1e6) * info.promptCost + (tokensOut / 1e6) * info.completionCost;
  }

  /** Is this something a desk can sit on: a known model, a route, or `auto`. */
  servable(model: string): boolean {
    return this.candidates(model).length > 0;
  }

  // ---- resolving what a desk asked for ------------------------------------

  /** Split `nim/z-ai/glm-5.3` into its provider and the id the provider knows. */
  private split(model: string): { provider: ProviderConfig; bare: string } | null {
    const slash = model.indexOf("/");
    if (slash > 0) {
      const p = this.provider(model.slice(0, slash));
      if (p) return { provider: p, bare: model.slice(slash + 1) };
    }
    // an id written before providers had names: find whoever serves it
    const hit = this.models.find((m) => m.id.endsWith(`/${model}`));
    if (hit?.provider) {
      const p = this.provider(hit.provider);
      if (p) return { provider: p, bare: hit.id.slice(hit.provider.length + 1) };
    }
    return null;
  }

  /**
   * The ordered list of models a desk on `model` may be served by. The first
   * tier is what it asked for; the second is the auto route, used only when the
   * first is out of quota for longer than a short wait.
   */
  candidates(model: string): { primary: string[]; fallback: string[] } & { length: number } {
    const routeOf = (id: string) => this.routes.find((r) => r.id === id || r.name === id);
    const usable = (m: string) => {
      const s = this.split(m);
      return Boolean(s && s.provider.enabled && (this.lanes.get(s.provider.id)?.length ?? 0) > 0);
    };
    const autoList = (): string[] => {
      const auto = routeOf("auto");
      if (auto?.models.length) return auto.models.filter(usable);
      // nobody wrote an auto route: every provider's suggested models, in the
      // order the providers were added, is a sensible pool to start from
      const picked: string[] = [];
      for (const p of this.providers) {
        if (!p.enabled || !(this.lanes.get(p.id)?.length)) continue;
        const preset = providerPreset(p.id);
        const listed = this.models.filter((m) => m.provider === p.id).map((m) => m.id);
        const wanted = (preset?.suggested ?? []).map((s) => `${p.id}/${s}`).filter((s) => !listed.length || listed.includes(s));
        picked.push(...(wanted.length ? wanted.slice(0, 1) : listed.slice(0, 1)));
      }
      return picked;
    };

    let primary: string[];
    const spec = model.replace(/^route:/, "");
    if (!spec || spec === "auto" || spec.startsWith("auto/")) primary = autoList();
    else if (routeOf(spec)) primary = routeOf(spec)!.models.filter(usable);
    else primary = usable(spec) ? [spec] : [];

    const fallback = this.fallback && spec !== "auto" ? autoList().filter((m) => !primary.includes(m)) : [];
    const out = { primary, fallback, length: primary.length + fallback.length };
    return out;
  }

  private isSick(model: string): boolean {
    const s = this.sick.get(model);
    if (!s) return false;
    if (s.until <= Date.now()) {
      this.sick.delete(model);
      return false;
    }
    return true;
  }

  private markSick(model: string, ms: number, why: string) {
    this.sick.set(model, { until: Date.now() + ms, why });
  }

  /**
   * Find a lane. Tries the primary models' keys first, least busy first; when
   * every one of them is resting for longer than a short wait, the fallback
   * tier is allowed in. Waits rather than failing, up to the point where the
   * wait itself is the answer - then says how long.
   */
  private async acquire(
    tiers: { primary: string[]; fallback: string[] },
    exclude: Set<string>,
    signal?: AbortSignal,
    onWait?: (ms: number) => void,
  ): Promise<{ lane: Lane; model: string; bare: string }> {
    const SHORT_WAIT = 12_000;
    const started = Date.now();
    for (;;) {
      const now = Date.now();
      let soonest = Infinity;
      for (const [tierName, list] of [["primary", tiers.primary], ["fallback", tiers.fallback]] as const) {
        const healthy = list.filter((m) => !this.isSick(m));
        // every model on the tier is sick: better a sick model than no model
        const pool = healthy.length ? healthy : list;
        let tierSoonest = Infinity;
        for (const model of pool) {
          const s = this.split(model);
          if (!s) continue;
          const lanes = (this.lanes.get(s.provider.id) ?? [])
            .filter((l) => !exclude.has(`${l.id} ${model}`))
            .sort((a, b) => a.inflight / a.limit - b.inflight / b.limit || a.stamps.length - b.stamps.length);
          for (const lane of lanes) {
            const w = lane.waitFor(now);
            if (w === 0) {
              lane.take(now);
              return { lane, model, bare: s.bare };
            }
            tierSoonest = Math.min(tierSoonest, w);
          }
        }
        soonest = Math.min(soonest, tierSoonest);
        // the primary tier is only skipped when its wait is longer than a breath
        if (tierName === "primary" && tierSoonest <= SHORT_WAIT && tiers.primary.length) break;
      }
      if (soonest === Infinity) {
        if (exclude.size) {
          // everything has been tried once this request - start the round again,
          // after a breath so a lane that just failed is not hammered in a loop
          exclude.clear();
          await sleep(1_500, signal);
          continue;
        }
        throw new Error("no provider can serve this model - add a key or pick another model");
      }
      if (Date.now() - started > 15 * 60_000) {
        throw new RateLimited(`every key for this model has been resting for 15 minutes`, Math.min(soonest, MAX_WAIT_MS), 429);
      }
      if (soonest > 1_500) onWait?.(soonest);
      await sleep(Math.min(Math.max(soonest, 250), 5_000), signal);
    }
  }

  private headers(lane: Lane): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (lane.key) h.Authorization = `Bearer ${lane.key}`;
    if (lane.provider.id === "openrouter") {
      h["HTTP-Referer"] = "https://github.com/kaanisthatyou/nightshift";
      h["X-Title"] = "nightshift";
    }
    return h;
  }

  /**
   * Provider-specific body fields. Reasoning is the one that matters: on a slow
   * provider a thinking model at default effort can spend its whole budget
   * before it writes a character.
   */
  private bodyExtras(lane: Lane, bare: string, level: ReasoningLevel): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const pid = lane.provider.id;
    if (level !== "default") {
      const effort = level === "off" ? "low" : level;
      if (pid === "gemini") {
        out.reasoning_effort = level === "off" ? "none" : effort;
      } else if (pid === "openrouter") {
        out.reasoning = level === "off" ? { enabled: false } : { effort };
      } else if (pid === "groq") {
        if (/gpt-oss/.test(bare)) out.reasoning_effort = effort;
        else if (/qwen/.test(bare)) out.reasoning_effort = level === "off" ? "none" : "default";
      } else if (pid === "nim") {
        // measured: NIM honours reasoning_effort for glm, ignores chat_template_kwargs for it
        out.reasoning_effort = effort;
      } else if (/gpt-oss|o\d|gpt-5/.test(bare)) {
        out.reasoning_effort = effort;
      }
    }
    return { ...out, ...lane.provider.params };
  }

  /**
   * Tool call ids have to survive a move between providers. Mistral insists on
   * nine alphanumerics, others hand out uuids; one shape everyone accepts.
   */
  private portable(messages: any[]): any[] {
    const map = new Map<string, string>();
    const fix = (idv: string) => {
      if (/^[a-zA-Z0-9]{9}$/.test(idv)) return idv;
      if (!map.has(idv)) {
        let h = 0;
        for (const ch of idv) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
        map.set(idv, `c${h.toString(36).padStart(8, "0").slice(-8)}`);
      }
      return map.get(idv)!;
    };
    return messages.map((m) => {
      if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
        return { ...m, tool_calls: m.tool_calls.map((c: any) => ({ ...c, id: fix(String(c.id)) })) };
      }
      if (m?.role === "tool" && m.tool_call_id) return { ...m, tool_call_id: fix(String(m.tool_call_id)) };
      return m;
    });
  }

  /** One-shot, no streaming callback needed. The planner uses it. */
  async complete(opts: {
    model: string;
    prompt: string;
    system?: string | null;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    reasoning?: ReasoningLevel | null;
    idleMs?: number;
  }): Promise<{ text: string; model: string; tokensIn: number; tokensOut: number; costUsd: number; decision: string | null }> {
    const res = await this.chat({ ...opts });
    return {
      text: res.text,
      model: res.model,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      costUsd: res.costUsd ?? 0,
      decision: res.decision,
    };
  }

  /**
   * Streaming chat, served by whichever lane is free. A lane that pushes back,
   * refuses the key, does not know the model or goes silent is set aside and the
   * same request goes to the next one - the caller sees one answer.
   */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const tiers = this.candidates(opts.model);
    if (!tiers.length) {
      throw new Error(
        this.providers.length
          ? `nothing serves ${opts.model} - pick a model a configured provider lists, or add its key`
          : "no provider configured - add an API key in the providers panel",
      );
    }
    const messages: any[] = opts.messages
      ? this.portable(opts.messages)
      : [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          { role: "user", content: opts.prompt ?? "" },
        ];

    const tried = new Set<string>();
    let lastError: Error | null = null;
    let lastLane: string | null = null;
    let hops = 0;
    const maxHops = 8;

    for (let attempt = 0; attempt < maxHops; attempt++) {
      const { lane, model, bare } = await this.acquire(tiers, tried, opts.signal, opts.onWait);
      const label = `${lane.id} ${bare}`;
      if (lastLane && lastLane !== label) {
        hops += 1;
        opts.onHop?.(lastLane, label, lastError?.message ?? "");
      }
      lastLane = label;
      try {
        const res = await this.stream(lane, bare, messages, opts);
        lane.release(true);
        return { ...res, model, decision: label, hops };
      } catch (err: any) {
        if (opts.signal?.aborted) {
          lane.release(false);
          throw err;
        }
        const e: LaneError = err instanceof LaneError ? err : new LaneError("flaky", err?.message ?? String(err));
        lastError = e;
        tried.add(`${lane.id} ${model}`);
        lane.release(false);
        if (e.kind === "limit") {
          lane.rest(e.waitMs || 15_000);
          continue;
        }
        if (e.kind === "auth") {
          lane.rest(30 * 60_000); // a refused key will not start working in a minute
          continue;
        }
        if (e.kind === "model") {
          this.markSick(model, 30 * 60_000, e.message);
          continue;
        }
        if (e.kind === "flaky") {
          this.markSick(model, 3 * 60_000, e.message);
          continue;
        }
        throw e; // a bad request is bad on every lane
      }
    }
    throw lastError ?? new Error("no lane answered");
  }

  private async stream(lane: Lane, bare: string, messages: any[], opts: ChatOptions): Promise<Omit<ChatResult, "model" | "decision">> {
    const p = lane.provider;
    const level = opts.reasoning ?? this.reasoning;
    // one controller for the caller's signal and the idle watchdog together
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const idleMs = opts.idleMs ?? 240_000;
    let watchdog: NodeJS.Timeout | null = null;
    let hung = false;
    const pet = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        hung = true;
        ctl.abort(new Error("stalled"));
      }, idleMs);
    };

    const body: Record<string, unknown> = {
      model: bare,
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1600,
      ...this.bodyExtras(lane, bare, level),
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
    };
    // usage in the stream is an OpenAI extension some servers reject outright
    if (p.id !== "gemini") body.stream_options = { include_usage: true };

    try {
      pet();
      let res: Response;
      try {
        res = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(lane),
          signal: ctl.signal,
          body: JSON.stringify(body),
        });
      } catch (err: any) {
        if (opts.signal?.aborted) throw err;
        throw new LaneError("flaky", hung ? `${lane.id} went silent for ${Math.round(idleMs / 1000)}s` : `network: ${err?.message ?? err}`);
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const short = text.slice(0, 300);
        if (res.status === 429 || (res.status === 503 && /rate.?limit|too many|quota/i.test(text))) {
          throw new LaneError("limit", `${lane.id} rate limited (${res.status})`, res.status, waitFrom(res));
        }
        if (res.status === 401 || res.status === 403) {
          throw new LaneError("auth", `${lane.id} refused the key (${res.status}): ${short}`, res.status);
        }
        if (res.status === 404 || /model.{0,20}(not.?found|does not exist|not supported|unknown)|no such model|invalid model/i.test(text)) {
          throw new LaneError("model", `${bare} is not served by ${p.id}: ${short}`, res.status);
        }
        if (res.status >= 500 || res.status === 408) {
          throw new LaneError("flaky", `${lane.id} ${res.status}: ${short}`, res.status);
        }
        throw new LaneError("request", `${p.id} ${res.status}: ${short || res.statusText}`, res.status);
      }

      let text = "";
      let reasoning = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let finishReason: string | null = null;
      const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pet();
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let json: any;
            try {
              json = JSON.parse(payload);
            } catch {
              continue;
            }
            if (json?.error) {
              const msg = String(json.error?.message ?? JSON.stringify(json.error)).slice(0, 300);
              throw new LaneError(/rate|quota|too many/i.test(msg) ? "limit" : "flaky", `${lane.id}: ${msg}`, 0, 15_000);
            }
            const choice = json?.choices?.[0];
            const delta = choice?.delta ?? {};
            if (typeof delta.content === "string" && delta.content) {
              text += delta.content;
              opts.onChunk?.(delta.content);
            }
            const think = delta.reasoning_content ?? delta.reasoning;
            if (typeof think === "string" && think) {
              reasoning += think;
              opts.onChunk?.(think);
            }
            for (const tc of delta.tool_calls ?? choice?.message?.tool_calls ?? []) {
              const idx = typeof tc.index === "number" ? tc.index : toolAcc.size;
              const slot = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name = tc.function.name;
              if (typeof tc.function?.arguments === "string") slot.arguments += tc.function.arguments;
              else if (tc.function?.arguments && typeof tc.function.arguments === "object") {
                slot.arguments = JSON.stringify(tc.function.arguments);
              }
              toolAcc.set(idx, slot);
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (json?.usage) {
              tokensIn = json.usage.prompt_tokens ?? tokensIn;
              tokensOut = json.usage.completion_tokens ?? tokensOut;
            }
          }
        }
      } catch (err: any) {
        if (err instanceof LaneError) throw err;
        if (opts.signal?.aborted) throw err;
        throw new LaneError("flaky", hung ? `${lane.id} went silent for ${Math.round(idleMs / 1000)}s` : `stream broke: ${err?.message ?? err}`);
      }

      const toolCalls: WireToolCall[] = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v], i) => ({ id: v.id || `call${i}`, name: v.name, arguments: v.arguments }))
        .filter((c) => c.name);

      const out = text.trim() || (toolCalls.length ? "" : reasoning.trim());
      if (!out && !toolCalls.length) {
        // an empty 200 is a lane problem, not an answer - try somewhere else
        throw new LaneError("flaky", `${lane.id} returned an empty reply${finishReason ? ` (${finishReason})` : ""}`);
      }
      if (!tokensIn) tokensIn = Math.ceil(JSON.stringify(messages).length / 4);
      if (!tokensOut) tokensOut = Math.ceil((text.length + reasoning.length + toolCalls.reduce((n, c) => n + c.arguments.length, 0)) / 4);
      return { text: out, tokensIn, tokensOut, ghost: false, costUsd: null, toolCalls, finishReason };
    } finally {
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
