// Where the models live. The floor talks to every one of these directly - no
// gateway in between - so this is the whole list of what "a provider" means:
// an OpenAI-compatible base URL, what its keys look like, and how hard one key
// may be leaned on before the provider says "not this minute".

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** how a pasted key announces which provider it belongs to */
  keyPrefix: string[];
  /** environment variables the floor reads a key from on boot */
  env: string[];
  /** requests a minute one key is allowed, as published; 0 when nobody says */
  rpm: number;
  /** requests one key may have in flight before the next one waits */
  concurrency: number;
  /** local servers need no key at all */
  keyless?: boolean;
  /** models worth putting at the top of the picker - the rest still work */
  suggested: string[];
  /** a line for the window */
  note: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "nim",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyPrefix: ["nvapi-"],
    env: ["NVIDIA_API_KEY", "NIM_API_KEY", "NGC_API_KEY"],
    rpm: 40,
    concurrency: 4,
    suggested: ["z-ai/glm-5.3", "moonshotai/kimi-k2.6", "deepseek-ai/deepseek-v4-flash-0731", "nvidia/nemotron-3-super-120b-a12b"],
    note: "free keys at build.nvidia.com - 40 requests a minute each, slow but strong models",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyPrefix: ["gsk_"],
    env: ["GROQ_API_KEY"],
    rpm: 30,
    concurrency: 4,
    suggested: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
    note: "very fast, tight tokens-per-minute on the free tier",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPrefix: ["AIza"],
    env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    rpm: 10,
    concurrency: 3,
    suggested: ["gemini-2.5-flash", "gemini-flash-latest"],
    note: "free tier through the OpenAI-compatible endpoint",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPrefix: ["sk-or-"],
    env: ["OPENROUTER_API_KEY"],
    rpm: 20,
    concurrency: 4,
    suggested: [],
    note: "one key, hundreds of models - the :free ones share a daily cap",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyPrefix: ["csk-"],
    env: ["CEREBRAS_API_KEY"],
    rpm: 30,
    concurrency: 4,
    suggested: [],
    note: "fastest tokens there are, small daily budget",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyPrefix: [],
    env: ["MISTRAL_API_KEY"],
    rpm: 60,
    concurrency: 4,
    suggested: ["devstral-medium-latest", "mistral-large-latest"],
    note: "devstral is built for agentic coding",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyPrefix: [],
    env: ["DEEPSEEK_API_KEY"],
    rpm: 60,
    concurrency: 8,
    suggested: ["deepseek-chat"],
    note: "cheap, no hard rate limit",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyPrefix: ["sk-proj-", "sk-"],
    env: ["OPENAI_API_KEY"],
    rpm: 60,
    concurrency: 8,
    suggested: [],
    note: "paid",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyPrefix: [],
    env: [],
    rpm: 0,
    concurrency: 1,
    keyless: true,
    suggested: [],
    note: "your own GPU - one request at a time is usually all it has",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    keyPrefix: [],
    env: [],
    rpm: 0,
    concurrency: 1,
    keyless: true,
    suggested: [],
    note: "local server tab in LM Studio",
  },
];

export const providerPreset = (id: string | null | undefined) => PROVIDER_PRESETS.find((p) => p.id === id);

/** Which preset a bare key most likely belongs to, by its prefix. Longest prefix wins. */
export function guessProvider(key: string): ProviderPreset | undefined {
  let best: { p: ProviderPreset; len: number } | undefined;
  for (const p of PROVIDER_PRESETS) {
    for (const prefix of p.keyPrefix) {
      if (key.startsWith(prefix) && (!best || prefix.length > best.len)) best = { p, len: prefix.length };
    }
  }
  return best?.p;
}

/**
 * How much a model is allowed to think before it writes. Reasoning models on a
 * slow provider will happily spend a whole reply budget thinking and deliver
 * nothing - measured on NIM, GLM at default effort burned 1200 tokens and wrote
 * zero characters, and `low` wrote the answer straight away.
 */
export type ReasoningLevel = "default" | "off" | "low" | "medium" | "high";
