/**
 * Provider + model catalog.
 *
 * Free tiers change constantly. These defaults were checked against provider docs
 * in September 2026, but treat every number as a starting point: verify in each
 * provider's console, then override at runtime with `PUT /admin/catalog`
 * (no redeploy needed). Limits are enforced *per API key*.
 */

export type Window = "minute" | "hour" | "day" | "month";

export interface Limit {
  window: Window;
  /** Max requests in the window. */
  requests?: number;
  /** Max input+output tokens in the window. */
  tokens?: number;
  /** Max shadow spend in USD, computed from `ModelDef.price`. */
  usd?: number;
}

export interface ModelDef {
  /** Upstream model id, exactly as the provider expects it. */
  id: string;
  /** Capability tags used by `auto:<tag>` and request filtering: tools, vision, fast, smart, coding, reasoning. */
  tags?: string[];
  /** Higher is tried first by `auto`. */
  priority?: number;
  /** Context window in tokens; requests that don't fit are skipped. */
  context?: number;
  /** USD per 1M tokens. Only needed where a free allowance is metered in money (e.g. Workers AI neurons). */
  price?: { in: number; out: number };
  /** Per-key limits specific to this model. */
  limits?: Limit[];
  /** Skipped by plain `auto`; still reachable by explicit id, `auto:<tag>` and profiles. */
  noAuto?: boolean;
  disabled?: boolean;
}

export type GatewayRoute =
  /** AI Gateway unified endpoint: POST /compat/chat/completions with model "<slug>/<id>". */
  | { mode: "compat"; slug: string }
  /** AI Gateway provider endpoint: POST /<path> with the bare model id. */
  | { mode: "path"; path: string };

export interface ProviderDef {
  id: string;
  /**
   * Set only when the provider has been shown to exclude prompt-cache hits from its own rate
   * limits. Then `settle()` bills `prompt_tokens - cached_tokens` against our token counters
   * instead of the full prompt. Off by default: most providers (OpenAI among them) still count a
   * cache hit toward TPM, and undercounting would push us past their real limit into 429s.
   *
   * The `CACHED_TOKENS_FREE` var (comma-separated provider ids) turns it on for one deploy
   * without committing the claim to the catalog, which is how an unproven provider gets tried.
   */
  cachedTokensFree?: boolean;
  name: string;
  /** Secret holding the API key(s). Comma/newline-separate several keys. */
  keyEnv: string;
  /** Works without a key (limits are then usually per IP). A key in `keyEnv` is still used if set. */
  keyless?: boolean;
  /** Where to create a key; shown in the dashboard. */
  signupUrl?: string;
  /** Free tier is unlocked by putting a card on file (never charged while under quota). Gets extra headroom. */
  requiresCard?: boolean;
  /** Milliseconds to wait for response headers; overrides UPSTREAM_TIMEOUT_MS for slow reasoning hosts. */
  timeoutMs?: number;
  /** How to reach the provider through AI Gateway. Omit to always call `directUrl`. */
  gateway?: GatewayRoute;
  /** OpenAI-compatible chat completions URL used when AI Gateway isn't configured. `{ACCOUNT_ID}` is substituted. */
  directUrl: string;
  /** Model list URL used by `/admin/probe` to spot stale catalog entries. */
  modelsUrl?: string;
  /** IANA time zone where the provider's daily/monthly quotas reset. */
  resetTz?: string;
  /** Per-key limits shared by every model of this provider. */
  limits?: Limit[];
  /** Hard $0 guard: model ids must match this regex or they are never called. */
  modelIdPattern?: string;
  /** Allow explicit "<provider>/<model>" requests for models not listed here (still subject to modelIdPattern). */
  allowUnlisted?: boolean;
  /** Provider accepts stream_options.include_usage (exact token accounting for streams). */
  streamUsage?: boolean;
  /**
   * Always call the provider with `stream: true`, and assemble the stream into one
   * chat.completion for clients that didn't ask for streaming. Meant for providers that answer
   * streams promptly but sit on non-streaming responses: the header timeout then only has to cover
   * time to first byte, and an error event mid-stream still fails over, because nothing has
   * reached the client yet.
   */
  forceStream?: boolean;
  headers?: Record<string, string>;
  models: ModelDef[];
  disabled?: boolean;
  notes?: string;
}

export interface Catalog {
  version: string;
  /** Stop routing to a key once this fraction of any limit is used (0.9 = keep 10% headroom). */
  safetyMargin: number;
  /** Limits for the whole Worker, keeps Workers / Durable Objects usage inside the free plan. */
  globalLimits: Limit[];
  /** Named fallback chains for `auto:<name>`, as "<provider>/<model>" refs in order. */
  profiles?: Record<string, string[]>;
  providers: ProviderDef[];
}

const groqLimits = (rpd: number, tpm: number, tpd?: number): Limit[] => [
  { window: "minute", requests: 30, tokens: tpm },
  { window: "day", requests: rpd, ...(tpd ? { tokens: tpd } : {}) },
];

// Tag notes
// - "structured": tested 2026-09-16 with a strict `json_schema` response_format asking for
//   {"city": string}. Only models that returned exactly that shape carry the tag. 20 of the 31
//   reachable tools models accepted the request and answered in prose or fenced markdown instead,
//   which is why the tag is opt-in rather than a deny list. Groq and Gemini were in a daily
//   cooldown that day and are untested, so they are currently skipped for strict-schema requests —
//   retest and tag them.
//   Vision models were probed on 2026-09-16 with an image and a nested strict schema (an array of
//   objects plus an enum), because a strict schema combined with an image had no candidates at all.
//   Only Workers AI's gemma-4-26b returned the exact shape. zhipu/glm-4.6v-flash answered in prose;
//   OpenRouter's ling-3.0-flash-vl and nex-n2.5-mini reject structured output with a 400, and
//   nex-n2.5-pro and dots-3-note-preview returned empty content. Gemini and four OpenRouter vision
//   models were in cooldown and are untested.
export const DEFAULT_CATALOG: Catalog = {
  version: "2026-09-16",
  safetyMargin: 0.9,
  // Each chat request costs ~1 Worker request + 2 Durable Object requests.
  // Workers Free = 100k requests/day, DO Free = 100k requests/day.
  globalLimits: [{ window: "day", requests: 30000 }],
  profiles: {
    // One model, every provider that serves it, so a client can pool separate free quotas.
    // Order is deliberate: Groq is by far the fastest but its 8k TPM (7.2k after the safety
    // margin) fits only small prompts — an agent turn is ~8.5k, so it self-skips at the quota
    // check for no HTTP cost. Ollama has no per-minute token ceiling and does the real work.
    // SambaNova stays listed for when a key arrives; Workers AI is last because its whole free
    // allowance is $0.11/day, about a dozen agent turns.
    oss120: [
      "groq/openai/gpt-oss-120b",
      "ollama/gpt-oss:120b",
      "sambanova/gpt-oss-120b",
      "workers-ai/@cf/openai/gpt-oss-120b",
    ],
    coding: [
      "groq/openai/gpt-oss-120b",
      "nvidia/moonshotai/kimi-k3",
      "mistral/codestral-latest",
      "google-ai-studio/gemini-flash-latest",
      "workers-ai/@cf/zai-org/glm-4.7-flash",
    ],
  },
  providers: [
    {
      id: "google-ai-studio",
      name: "Google AI Studio (Gemini)",
      keyEnv: "GEMINI_API_KEY",
      signupUrl: "https://aistudio.google.com/apikey",
      gateway: { mode: "compat", slug: "google-ai-studio" },
      directUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
      resetTz: "America/Los_Angeles",
      notes:
        "Free tier only while the Google Cloud project has NO billing account attached. Live limits: aistudio.google.com/rate-limit. Free-tier prompts may be used for training.",
      models: [
        {
          id: "gemini-flash-latest",
          tags: ["smart", "tools", "vision", "coding"],
          priority: 92,
          context: 1_048_576,
          limits: [
            { window: "minute", requests: 10, tokens: 250_000 },
            { window: "day", requests: 250 },
          ],
        },
        {
          id: "gemini-flash-lite-latest",
          tags: ["fast", "tools", "vision"],
          priority: 72,
          context: 1_048_576,
          limits: [
            { window: "minute", requests: 15, tokens: 250_000 },
            { window: "day", requests: 1000 },
          ],
        },
      ],
    },
    {
      id: "groq",
      name: "Groq",
      keyEnv: "GROQ_API_KEY",
      signupUrl: "https://console.groq.com/keys",
      gateway: { mode: "compat", slug: "groq" },
      directUrl: "https://api.groq.com/openai/v1/chat/completions",
      modelsUrl: "https://api.groq.com/openai/v1/models",
      resetTz: "UTC",
      streamUsage: true,
      notes: "Free plan limits from console.groq.com/docs/rate-limits.",
      models: [
        { id: "openai/gpt-oss-120b", tags: ["smart", "tools", "reasoning", "coding"], priority: 90, context: 131_072, limits: groqLimits(1000, 8000, 200_000) },
        { id: "qwen/qwen3.8-27b", tags: ["smart", "tools", "coding"], priority: 85, context: 131_072, limits: groqLimits(1000, 8000, 200_000) },
        { id: "qwen/qwen3.6-27b", tags: ["tools", "coding"], priority: 75, context: 131_072, limits: groqLimits(1000, 8000, 200_000) },
        { id: "openai/gpt-oss-20b", tags: ["fast", "tools", "reasoning"], priority: 70, context: 131_072, limits: groqLimits(1000, 8000, 200_000) },
        // Tested 2026-09-15: any prompt that triggers web search returns 413 "Request Entity Too Large" when not
        // streaming. Streaming sends the whole reply (answer after </think>) as delta.reasoning, then ends with a
        // 413 error event instead of finish_reason. Prompts without search work. Kept out of auto, auto:smart/fast.
        { id: "groq/compound", tags: ["search"], priority: 60, noAuto: true, limits: groqLimits(250, 70_000) },
        { id: "groq/compound-mini", tags: ["search"], priority: 55, noAuto: true, limits: groqLimits(250, 70_000) },
      ],
    },
    {
      id: "cerebras",
      name: "Cerebras",
      keyEnv: "CEREBRAS_API_KEY",
      gateway: { mode: "compat", slug: "cerebras" },
      directUrl: "https://api.cerebras.ai/v1/chat/completions",
      modelsUrl: "https://api.cerebras.ai/v1/models",
      resetTz: "UTC",
      streamUsage: true,
      // Disabled 2026-09-14: no longer free. Requests return 402 Payment Required unless
      // the account has a payment method (then $5 trial credits, expiring after 30 days).
      disabled: true,
      notes: "Disabled: no free tier anymore (402 Payment Required without billing).",
      models: [
        {
          id: "gpt-oss-120b",
          tags: ["smart", "fast", "tools", "reasoning", "coding"],
          priority: 88,
          context: 131_072,
          limits: [
            { window: "minute", requests: 5, tokens: 30_000 },
            { window: "hour", tokens: 1_000_000 },
            { window: "day", tokens: 1_000_000 },
          ],
        },
        {
          id: "qwen-3.8-27b",
          tags: ["smart", "fast", "tools", "vision", "coding"],
          priority: 84,
          context: 131_072,
          limits: [
            { window: "minute", requests: 5, tokens: 30_000 },
            { window: "hour", tokens: 1_000_000 },
            { window: "day", tokens: 1_000_000 },
          ],
        },
      ],
    },
    {
      id: "nvidia",
      name: "NVIDIA NIM (build.nvidia.com)",
      keyEnv: "NVIDIA_API_KEY",
      signupUrl: "https://build.nvidia.com/settings/api-keys",
      // Not a built-in AI Gateway provider. To log it through the gateway, create a
      // Custom Provider with slug "nvidia" (base URL https://integrate.api.nvidia.com)
      // and set gateway: { mode: "path", path: "custom-nvidia/v1/chat/completions" }.
      directUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      modelsUrl: "https://integrate.api.nvidia.com/v1/models",
      resetTz: "UTC",
      streamUsage: true,
      allowUnlisted: true,
      limits: [{ window: "minute", requests: 40 }],
      models: [
        { id: "moonshotai/kimi-k3", tags: ["smart", "tools", "coding"], priority: 86 },
        { id: "deepseek-ai/deepseek-v4-flash-0731", tags: ["smart", "tools", "coding"], priority: 82 },
        { id: "z-ai/glm-5.3-flash", tags: ["fast", "tools", "coding"], priority: 74 },
        { id: "nvidia/nemotron-3-super-120b-a12b", tags: ["tools"], priority: 66 },
        { id: "openai/gpt-oss-20b", tags: ["fast", "tools"], priority: 58 },
      ],
    },
    {
      id: "mistral",
      name: "Mistral (Free plan)",
      keyEnv: "MISTRAL_API_KEY",
      signupUrl: "https://console.mistral.ai/api-keys",
      gateway: { mode: "compat", slug: "mistral" },
      directUrl: "https://api.mistral.ai/v1/chat/completions",
      modelsUrl: "https://api.mistral.ai/v1/models",
      resetTz: "UTC",
      notes:
        "Free plan: $10/month of API credits, resetting on the 1st. Keep API pay-as-you-go disabled so overage fails instead of billing. Request limits: Admin → Limits.",
      // $10 monthly allowance, metered with list prices (mistral.ai/pricing/api, Sept 2026).
      limits: [{ window: "month", usd: 10 }],
      // Tested on the Free plan 2026-09-14: only these answer. mistral-large returns 403 "not available in
      // your subscription tier"; mistral-small/medium, devstral and magistral return 429 code 1300 on the
      // first request. Per-model limits from Admin → Limits (requests/second × 60).
      models: [
        {
          id: "codestral-latest",
          tags: ["coding", "tools", "structured"],
          priority: 68,
          price: { in: 0.3, out: 0.9 },
          limits: [{ window: "minute", requests: 120, tokens: 625_000 }],
        },
        {
          id: "ministral-14b-latest",
          tags: ["tools", "structured"],
          priority: 56,
          price: { in: 0.2, out: 0.2 },
          limits: [{ window: "minute", requests: 30, tokens: 937_500 }],
        },
        {
          id: "ministral-8b-latest",
          tags: ["fast", "tools", "structured"],
          priority: 50,
          price: { in: 0.15, out: 0.15 },
          limits: [{ window: "minute", requests: 180, tokens: 625_000 }],
        },
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter (:free models only)",
      keyEnv: "OPENROUTER_API_KEY",
      signupUrl: "https://openrouter.ai/settings/keys",
      gateway: { mode: "path", path: "openrouter/v1/chat/completions" },
      directUrl: "https://openrouter.ai/api/v1/chat/completions",
      modelsUrl: "https://openrouter.ai/api/v1/models",
      resetTz: "UTC",
      streamUsage: true,
      // $0 guard: paid OpenRouter models are never called, even if requested explicitly.
      modelIdPattern: ":free$",
      allowUnlisted: true,
      notes:
        "20 req/min and 50 req/day across all :free models (1000/day after a one-time $10 credit purchase — raise the day limit via /admin/catalog). Free model list refreshes daily via cron.",
      limits: [
        { window: "minute", requests: 20 },
        { window: "day", requests: 50 },
      ],
      models: [
        { id: "nvidia/nemotron-3-ultra-550b-a55b:free", tags: ["smart", "tools", "structured"], priority: 78, context: 1_000_000 },
        { id: "nvidia/nemotron-3-super-120b-a12b:free", tags: ["smart", "tools"], priority: 64, context: 262_144 },
        { id: "google/gemma-4-31b-it:free", tags: ["tools"], priority: 52, context: 262_144 },
      ],
    },
    {
      id: "zhipu",
      name: "Zhipu AI (GLM flash)",
      keyEnv: "ZHIPU_API_KEY",
      signupUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      directUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models",
      resetTz: "Asia/Shanghai",
      // Flash models reason before the first byte (40s+ observed), so allow a long wait for headers.
      timeoutMs: 90_000,
      modelIdPattern: "flash",
      allowUnlisted: true,
      notes: "Free GLM *-flash models, ~1M tokens/day each (FreeLLMAPI's figures). Slow: hidden reasoning before the answer.",
      models: [
        { id: "glm-4.7-flash", tags: ["tools", "reasoning", "coding"], priority: 46, context: 131_072, limits: [{ window: "day", tokens: 1_000_000 }] },
        { id: "glm-4.5-flash", tags: ["tools"], priority: 42, context: 131_072, limits: [{ window: "day", tokens: 1_000_000 }] },
        { id: "glm-4.6v-flash", tags: ["tools", "vision"], priority: 40, context: 131_072, limits: [{ window: "day", tokens: 1_000_000 }] },
      ],
    },
    {
      id: "opencode",
      name: "OpenCode Zen (free promos)",
      keyEnv: "OPENCODE_API_KEY",
      directUrl: "https://opencode.ai/zen/v1/chat/completions",
      modelsUrl: "https://opencode.ai/zen/v1/models",
      resetTz: "UTC",
      streamUsage: true,
      // $0 guard: Zen also sells Claude/GPT/Gemini. Only the promotional free ids may be called.
      modelIdPattern: "(-free$|^big-pickle$)",
      allowUnlisted: true,
      // Disabled 2026-09-14: free models now reject API use outside the OpenCode app
      // ("OpenCode's free tier can only be used in OpenCode"; shows up as 429 FreeUsageLimitError from Workers).
      disabled: true,
      notes: "Disabled: free tier only works inside the OpenCode app.",
      models: [
        { id: "deepseek-v4-flash-free", tags: ["smart", "tools", "coding"], priority: 62, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 200 }] },
        { id: "nemotron-3-ultra-free", tags: ["smart", "tools"], priority: 60, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 200 }] },
        { id: "nemotron-3.5-lightning-free", tags: ["fast", "tools"], priority: 48, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 200 }] },
        { id: "mimo-v2.5-free", tags: [], priority: 44, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 200 }] },
        { id: "big-pickle", tags: [], priority: 38, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 200 }] },
      ],
    },
    {
      id: "kilo",
      name: "Kilo Gateway (keyless :free)",
      keyEnv: "KILO_API_KEY",
      keyless: true,
      directUrl: "https://api.kilo.ai/api/gateway/v1/chat/completions",
      modelsUrl: "https://api.kilo.ai/api/gateway/models",
      resetTz: "UTC",
      modelIdPattern: "(:free$|/free$)",
      allowUnlisted: true,
      notes: "No key. Kilo allows 200 req/hour per IP; Workers share Cloudflare egress IPs, so real capacity may be lower. Free prompts are logged for training.",
      limits: [{ window: "hour", requests: 200 }],
      models: [
        { id: "nvidia/nemotron-3-ultra-550b-a55b:free", tags: ["smart", "tools", "structured"], priority: 58, context: 1_000_000 },
        { id: "nvidia/nemotron-3-super-120b-a12b:free", tags: ["tools", "structured"], priority: 50, context: 262_144 },
        { id: "cohere/north-mini-code:free", tags: ["tools", "coding"], priority: 45, context: 256_000 },
        { id: "poolside/laguna-s-2.1:free", tags: ["tools"], priority: 40, context: 262_144 },
        { id: "stepfun/step-3.7-flash:free", tags: ["fast"], priority: 36, context: 262_144 },
      ],
    },
    {
      id: "llm7",
      name: "LLM7 (open-weight models)",
      keyEnv: "LLM7_API_KEY",
      signupUrl: "https://token.llm7.io",
      directUrl: "https://api.llm7.io/v1/chat/completions",
      modelsUrl: "https://api.llm7.io/v1/models",
      resetTz: "UTC",
      // LLM7 also lists closed models (Claude, GPT, Gemini). Their provenance is unclear, so only
      // open-weight models are routed.
      modelIdPattern: "^(?!.*(claude|gpt|gemini|grok|o[0-9])).*$",
      allowUnlisted: false,
      notes: "~100 requests/hour per key. Closed models LLM7 lists (Claude, GPT, Gemini) are blocked on purpose.",
      limits: [{ window: "hour", requests: 100 }],
      models: [
        // Tested 2026-09-14: only these are free. deepseek-v4-pro, kimi-k3, glm-5.3 and glm-5.3-flash
        // return 402 "Insufficient balance".
        { id: "minimax-m2.7", tags: ["tools"], priority: 47 },
        { id: "codestral-latest", tags: ["coding", "tools", "structured"], priority: 43, context: 32_000 },
      ],
    },
    {
      id: "ollama",
      name: "Ollama Cloud (Free plan)",
      keyEnv: "OLLAMA_API_KEY",
      signupUrl: "https://ollama.com/settings/keys",
      directUrl: "https://ollama.com/v1/chat/completions",
      modelsUrl: "https://ollama.com/v1/models",
      resetTz: "UTC",
      timeoutMs: 120_000,
      // $0 guard: the Free plan's included usage covers only these models (Ollama settings, 2026-09-14).
      // Everything else draws from paid usage credits. Keep Auto-reload off.
      modelIdPattern: "^(gemma4:31b|gpt-oss:120b|gpt-oss:20b|nemotron-3-nano:30b|nemotron-3-super|nemotron-3-ultra)$",
      notes:
        "Free plan: weekly included usage (GPU time, shown as % in Ollama settings) on 6 models. Keep usage-credit Auto-reload off.",
      limits: [{ window: "minute", requests: 10 }],
      models: [
        { id: "nemotron-3-ultra", tags: ["smart", "tools"], priority: 30 }, // ~80s per answer on the Free plan
        { id: "gpt-oss:120b", tags: ["smart", "tools", "reasoning"], priority: 54, context: 131_072 },
        { id: "nemotron-3-super", tags: ["tools"], priority: 46 },
        { id: "gemma4:31b", tags: [], priority: 41, context: 131_072 },
        { id: "nemotron-3-nano:30b", tags: ["fast", "tools"], priority: 37 },
        { id: "gpt-oss:20b", tags: ["fast", "tools", "reasoning"], priority: 35, context: 131_072 },
      ],
    },
    {
      id: "sambanova",
      name: "SambaNova Cloud",
      keyEnv: "SAMBANOVA_API_KEY",
      signupUrl: "https://cloud.sambanova.ai/apis",
      directUrl: "https://api.sambanova.ai/v1/chat/completions",
      modelsUrl: "https://api.sambanova.ai/v1/models",
      resetTz: "UTC",
      streamUsage: true,
      // Disabled 2026-09-17: a fresh key without a card gets 402 "A payment method is required" on
      // DeepSeek-V3.1 and V3.2 alike, and the /v1/models list still answers. The docs' "free while no
      // payment method is on the account" no longer holds, and adding a card makes it paid.
      disabled: true,
      notes:
        "Disabled: API calls return 402 'A payment method is required' without a card (tested 2026-09-17), and a card switches the account to paid.",
      models: [
        { id: "DeepSeek-V3.1", tags: ["smart", "tools", "coding"], priority: 64, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
        { id: "DeepSeek-V3.2", tags: ["smart", "tools", "coding"], priority: 63, context: 32_768, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
        { id: "MiniMax-M3", tags: ["smart", "tools"], priority: 58, context: 1_048_576, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
        { id: "gpt-oss-120b", tags: ["smart", "tools", "reasoning"], priority: 55, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
        { id: "MiniMax-M2.7", tags: ["tools"], priority: 50, context: 196_608, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
        { id: "Meta-Llama-3.3-70B-Instruct", tags: ["tools"], priority: 45, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
        { id: "gemma-4-31B-it", tags: ["tools"], priority: 40, context: 131_072, limits: [{ window: "minute", requests: 20 }, { window: "day", requests: 20, tokens: 200000 }] },
      ],
    },
    {
      id: "routeway",
      name: "Routeway (:free models)",
      keyEnv: "ROUTEWAY_API_KEY",
      signupUrl: "https://routeway.ai",
      directUrl: "https://api.routeway.ai/v1/chat/completions",
      modelsUrl: "https://api.routeway.ai/v1/models",
      resetTz: "UTC",
      // Cloudflare in front of Routeway rejects non-browser user agents (error 1010).
      headers: { "user-agent": "Mozilla/5.0 (compatible; Forager/1.0; +https://fora.ger.soy)" },
      modelIdPattern: ":free$",
      notes: "Free pool: docs say 20 req/min and 200 req/day; a live test elsewhere saw 5 req/min, so Forager assumes 5.",
      limits: [{ window: "minute", requests: 5 }, { window: "day", requests: 200 }],
      // Tested 2026-09-17. minimax-m2.7: "ok" in 3.1 s (0.5 s streamed), correct tool call, but a strict
      // json_schema came back as prose that starts with its <think> block. deepseek-v4-flash: 429
      // "model_overloaded" on three tries and one 30 s timeout, so it is unverified. muse-glimmer-30b:
      // "ok" in 8 s, but it called the red test PNG "black" after 54 s, so it carries no vision tag.
      // Streams put MiniMax's <think>…</think> reasoning inside `content`.
      models: [
        { id: "deepseek-v4-flash:free", tags: ["smart", "tools", "coding"], priority: 61, context: 42_000 },
        { id: "minimax-m2.7:free", tags: ["tools"], priority: 51, context: 42_000 },
        { id: "muse-glimmer-30b:free", tags: [], priority: 38, context: 131_072 },
      ],
    },
    {
      id: "requesty",
      name: "Requesty (free models)",
      keyEnv: "REQUESTY_API_KEY",
      signupUrl: "https://app.requesty.ai/api-keys",
      directUrl: "https://router.requesty.ai/v1/chat/completions",
      modelsUrl: "https://router.requesty.ai/v1/models",
      resetTz: "UTC",
      // Big free models can take 30s+, and a request Forager abandons still holds one of the few
      // concurrent slots a $0 balance gets, so wait long enough to get the answer.
      timeoutMs: 120_000,
      // $0 guard: Requesty sells hundreds of paid models; only its $0 models (Sept 2026 list) may be called.
      modelIdPattern:
        "^(nvidia/(nemotron-3-ultra-550b-a55b|nemotron-3-super-120b-a12b|nemotron-3-nano-30b-a3b|nemotron-3-nano-omni-30b-a3b-reasoning|nemotron-3\\.5-lightning-30b-a3b|muse-glimmer-30b)|google/gemma-4-31b-it|mistral/leanstral-1-5|poolside/laguna-(m\\.1|xs\\.2)|novita/inclusionai/ling-3\\.0-tiny)$",
      // Disabled 2026-09-14: with a $0 balance Requesty allows almost no concurrency. The first request hangs
      // for minutes and the rest return 429 "limit of concurrent requests ... scales with your organization's balance".
      disabled: true,
      notes: "Disabled: free models need a positive balance for any usable concurrency.",
      models: [
        { id: "nvidia/nemotron-3-ultra-550b-a55b", tags: ["smart", "tools"], priority: 49, context: 1_048_576, limits: [{ window: "day", requests: 200 }] },
        { id: "nvidia/nemotron-3-super-120b-a12b", tags: ["tools"], priority: 45, context: 1_048_576, limits: [{ window: "day", requests: 200 }] },
        { id: "google/gemma-4-31b-it", tags: ["tools", "vision"], priority: 43, context: 262_144, limits: [{ window: "day", requests: 200 }] },
        { id: "nvidia/nemotron-3.5-lightning-30b-a3b", tags: ["fast", "tools"], priority: 41, context: 1_048_576, limits: [{ window: "day", requests: 200 }] },
        { id: "mistral/leanstral-1-5", tags: ["tools", "coding"], priority: 39, context: 262_144, limits: [{ window: "day", requests: 200 }] },
        { id: "nvidia/muse-glimmer-30b", tags: ["tools", "vision"], priority: 37, context: 131_072, limits: [{ window: "day", requests: 200 }] },
        { id: "nvidia/nemotron-3-nano-30b-a3b", tags: ["fast", "tools"], priority: 35, context: 262_144, limits: [{ window: "day", requests: 200 }] },
        { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", tags: ["tools", "vision", "reasoning"], priority: 33, context: 131_072, limits: [{ window: "day", requests: 200 }] },
        { id: "novita/inclusionai/ling-3.0-tiny", tags: ["fast", "tools"], priority: 29, context: 262_144, limits: [{ window: "day", requests: 200 }] },
        { id: "poolside/laguna-m.1", tags: [], priority: 27, context: 32_768, limits: [{ window: "day", requests: 200 }] },
        { id: "poolside/laguna-xs.2", tags: ["fast"], priority: 25, context: 32_768, limits: [{ window: "day", requests: 200 }] },
      ],
    },
    {
      id: "agnes",
      name: "Agnes AI",
      keyEnv: "AGNES_API_KEY",
      signupUrl: "https://platform.agnes-ai.com",
      directUrl: "https://apihub.agnes-ai.com/v1/chat/completions",
      modelsUrl: "https://apihub.agnes-ai.com/v1/models",
      resetTz: "UTC",
      timeoutMs: 60_000,
      modelIdPattern: "^agnes-",
      allowUnlisted: true,
      // Tested 2026-09-17: agnes-2.0-flash answered "ok" (0.8 s) and read the red test PNG ("Red", 2.7 s),
      // but the "free users" rate limit ("Upgrade to a Token Plan") tripped after one request every
      // ~25 s, and a minute later Cloudflare in front of Agnes answered 1015 (IP rate limit, and Workers
      // share egress IPs). Docs say 20 req/min; real capacity is closer to 1-2/min. Tools and strict
      // schemas are untested for that reason.
      notes: "Promotional $0 pricing on Agnes' own models (can end). Docs say 20 req/min, but free users hit a rate limit after about one request per 25 s, then Cloudflare 1015 blocks (tested 2026-09-17). No published daily cap.",
      limits: [{ window: "minute", requests: 2 }],
      models: [{ id: "agnes-2.0-flash", tags: ["tools", "vision"], priority: 42, context: 262_144 }],
    },
    {
      id: "vercel",
      name: "Vercel AI Gateway (card on file)",
      keyEnv: "VERCEL_AI_GATEWAY_KEY",
      signupUrl: "https://vercel.com/ai-gateway",
      requiresCard: true,
      directUrl: "https://ai-gateway.vercel.sh/v1/chat/completions",
      modelsUrl: "https://ai-gateway.vercel.sh/v1/models",
      resetTz: "UTC",
      // $0 guard: only models Vercel prices at $0. The $5/month free credit may cover more; widen after testing.
      // Never buy AI Gateway credits: that ends the free tier and makes paid models billable.
      modelIdPattern: "^(poolside/laguna-s-2\\.1-free|inclusionai/ling-3\\.0-flash-(fin|sante|vl)(-free)?)$",
      notes:
        "Needs a card on file to unlock the monthly $5 free credit. You're only charged if you buy AI Gateway credits, so don't. Free tier has lower per-model rate limits.",
      limits: [{ window: "month", usd: 5 }],
      models: [
        { id: "poolside/laguna-s-2.1-free", tags: ["tools"], priority: 34 },
        { id: "inclusionai/ling-3.0-flash-vl-free", tags: ["tools", "vision"], priority: 32 },
        { id: "inclusionai/ling-3.0-flash-fin-free", tags: ["tools"], priority: 24 },
      ],
    },
    {
      id: "ovh",
      name: "OVHcloud AI Endpoints (anonymous)",
      // Never add a key: authenticated AI Endpoints calls are billed per token. Anonymous only.
      keyEnv: "OVH_AI_ENDPOINTS_KEY",
      keyless: true,
      directUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
      modelsUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models",
      resetTz: "UTC",
      // Tested 2026-09-16 without a key, red 32x32 PNG: Qwen2.5-VL-72B and Mistral-Small-3.2 both answered
      // "Red.". Docs say 2 req/min per IP per model, but the third request in a minute got a 429 whichever
      // model it named, and the throttle then held for several minutes. So 2/min across the provider, and
      // only as a vision fallback (noAuto). From the live Worker the same day, 1 of 6 requests got through
      // ("Red.", ~1.2 s); the rest were immediate 429s (~1 s), because other Cloudflare customers already
      // spend the shared egress IPs' allowance. Cheap to try last, never something to rely on.
      notes:
        "No key: 2 req/min per IP, and Workers share egress IPs with other Cloudflare customers, so most attempts get a quick 429 (1 of 6 succeeded, 2026-09-16). Do NOT add a key: authenticated calls are billed. Last-resort vision fallback only (auto:vision).",
      limits: [{ window: "minute", requests: 2 }],
      models: [
        { id: "Qwen2.5-VL-72B-Instruct", tags: ["vision"], priority: 30, context: 32_000, noAuto: true },
        { id: "Mistral-Small-3.2-24B-Instruct-2506", tags: ["tools", "vision"], priority: 28, context: 128_000, noAuto: true },
        // Untested: 429 on every attempt 2026-09-16 (throttle from the calls above). Qwen3.8 reads images.
        { id: "Qwen3.8-27B", tags: ["tools", "vision", "reasoning"], priority: 27, context: 131_072, noAuto: true },
      ],
    },
    {
      id: "tokenharbor",
      name: "Token Harbor (:free models)",
      keyEnv: "TOKENHARBOR_API_KEY",
      signupUrl: "https://tokenharbor.ai/dashboard",
      directUrl: "https://tokenharbor.ai/v1/chat/completions",
      modelsUrl: "https://tokenharbor.ai/v1/models",
      resetTz: "UTC",
      // Streamed on the first guess that it only sat on non-streaming answers ("ok" streamed in
      // 1.4 s, 60 s without). Repeat runs the same day disproved it: streamed requests also waited
      // 29-60 s for the first byte, so the delay is a queue in front of every request. Kept on
      // because it costs nothing and lets a mid-stream error fail over; it is not a speed fix.
      forceStream: true,
      // Time to first byte, which reached 60 s. The provider is a slow fallback, so wait for it.
      timeoutMs: 90_000,
      // $0 guard: Token Harbor also sells Claude/GPT; per its quickstart only ids ending in ":free"
      // never charge the balance.
      modelIdPattern: ":free$",
      allowUnlisted: true,
      notes:
        "Free monthly allowance (4 windows of 7 days), size not published; no card. Blocks mainland China, Hong Kong and Macau. Free-model prompts may be kept for diagnostics and product improvement.",
      models: [
        // Tested 2026-09-16 through the Worker. /v1/models lists exactly these three :free ids.
        // "ok" took anywhere from 1.4 s to 60 s, streamed or not. A 32x32 PNG took 44 s on
        // deepseek-v4.1-flash and 76 s on mimo-v2.5 (both answered "Red", after hidden reasoning).
        // deepseek-v4-flash made two parallel tool calls correctly.
        // Priorities sit below the faster providers so this is a fallback, not the first stop.
        { id: "deepseek-v4-flash:free", tags: ["smart", "tools", "coding"], priority: 36, context: 1_048_576 },
        { id: "deepseek-v4.1-flash:free", tags: ["smart", "tools", "vision", "reasoning", "coding"], priority: 35, context: 1_048_576 },
        { id: "mimo-v2.5:free", tags: ["tools", "vision", "reasoning"], priority: 31 },
      ],
    },
    {
      id: "orcarouter",
      name: "OrcaRouter (-free models)",
      keyEnv: "ORCAROUTER_API_KEY",
      signupUrl: "https://www.orcarouter.ai",
      directUrl: "https://api.orcarouter.ai/v1/chat/completions",
      modelsUrl: "https://api.orcarouter.ai/v1/models",
      resetTz: "UTC",
      // $0 guard: OrcaRouter bills every other model at upstream prices.
      modelIdPattern: "-free$",
      allowUnlisted: true,
      notes:
        "Hacker plan, no card: free models are rate-limited with unpublished 'conservative caps' (429 + Retry-After). Free models only unlock once the workspace owner links a GitHub account that isn't brand new (429 free_rate_limited until then). Topping up raises the limits.",
      models: [
        // Tested 2026-09-17 through the Worker, all fast: "ok" in 1.4-3.1 s, glm-5.3-flash read the red
        // test PNG in 3.3 s and made a correct tool call. Strict nested json_schema (array of objects,
        // number, enum): deepseek-v4-flash and hy3 returned the exact shape; glm-5.3-flash answered in
        // markdown with and without an image, so it stays untagged.
        { id: "z-ai/glm-5.3-flash-free", tags: ["smart", "tools", "vision", "coding"], priority: 55, context: 1_000_000 },
        { id: "deepseek/deepseek-v4-flash-free", tags: ["smart", "tools", "coding", "structured"], priority: 53, context: 1_048_576 },
        { id: "tencent/hy3-free", tags: ["tools", "reasoning", "structured"], priority: 39, context: 262_144 },
      ],
    },
    {
      id: "electronhub",
      name: "Electron Hub (:free, 10 req/day)",
      keyEnv: "ELECTRONHUB_API_KEY",
      signupUrl: "https://electronhub.ai",
      directUrl: "https://api.electronhub.ai/v1/chat/completions",
      modelsUrl: "https://api.electronhub.ai/v1/models",
      // Free "Neutrinos" reset at 21:00 UTC, which is midnight at UTC+3.
      resetTz: "Etc/GMT-3",
      // $0 guard: only :free vision models that cost 1 Neutrino per request (/v1/models, 2026-09-16).
      // Others cost 2-5 per request, which a request counter would undercount, and the :free Claude
      // model's provenance is unclear.
      modelIdPattern:
        "^(gemma-4-26b-a4b-it|gemma-4-31b-it|mistral-small-3\\.2-24b-instruct|qwen3\\.6-27b|qwen3\\.6-35b-a3b|ministral-3-8b-instruct):free$",
      notes:
        "10 free requests/day (reset 21:00 UTC); failed and cancelled requests count too. Free models need phone verification on the Electron Hub account first (403 until then). Watching ads raises it to 200, which Forager can't do. Kept for vision only (auto:vision) so text traffic can't spend it.",
      limits: [{ window: "day", requests: 10 }],
      models: [
        { id: "qwen3.6-27b:free", tags: ["tools", "vision"], priority: 25, context: 64_000, noAuto: true },
        { id: "gemma-4-31b-it:free", tags: ["tools", "vision", "reasoning"], priority: 24, context: 40_000, noAuto: true },
        { id: "mistral-small-3.2-24b-instruct:free", tags: ["tools", "vision"], priority: 23, context: 64_000, noAuto: true },
        { id: "gemma-4-26b-a4b-it:free", tags: ["tools", "vision", "reasoning"], priority: 22, context: 64_000, noAuto: true },
        { id: "qwen3.6-35b-a3b:free", tags: ["tools", "vision", "reasoning"], priority: 21, context: 40_000, noAuto: true },
        { id: "ministral-3-8b-instruct:free", tags: ["fast", "tools", "vision"], priority: 18, context: 64_000, noAuto: true },
      ],
    },
    {
      id: "cohere",
      name: "Cohere (trial key)",
      keyEnv: "COHERE_API_KEY",
      signupUrl: "https://dashboard.cohere.com/api-keys",
      gateway: { mode: "compat", slug: "cohere" },
      directUrl: "https://api.cohere.ai/compatibility/v1/chat/completions",
      modelsUrl: "https://api.cohere.ai/v1/models?endpoint=chat",
      resetTz: "UTC",
      allowUnlisted: true,
      notes: "Trial keys: 20 chat req/min, 1000 calls/month, non-commercial use only.",
      limits: [
        { window: "minute", requests: 20 },
        { window: "month", requests: 1000 },
      ],
      models: [{ id: "command-a-03-2025", tags: ["tools", "structured"], priority: 50, context: 256_000 }],
    },
    {
      id: "workers-ai",
      name: "Cloudflare Workers AI",
      keyEnv: "CF_API_TOKEN",
      signupUrl: "https://dash.cloudflare.com/profile/api-tokens",
      gateway: { mode: "compat", slug: "workers-ai" },
      directUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions",
      modelsUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/models/search?task=Text%20Generation",
      resetTz: "UTC",
      streamUsage: true,
      notes:
        "10,000 neurons/day free ($0.011 per 1k neurons after that on the Paid plan). Tracked as $0.11/day of shadow spend using official per-token prices.",
      // 10,000 neurons × $0.011 / 1,000 = $0.11
      limits: [{ window: "day", usd: 0.11 }],
      models: [
        { id: "@cf/openai/gpt-oss-120b", tags: ["smart", "tools", "reasoning"], priority: 30, context: 131_072, price: { in: 0.35, out: 0.75 } },
        { id: "@cf/zai-org/glm-4.7-flash", tags: ["fast", "tools", "coding"], priority: 28, price: { in: 0.06, out: 0.4 } },
        { id: "@cf/google/gemma-4-26b-a4b-it", tags: ["fast", "tools", "vision", "structured"], priority: 26, price: { in: 0.1, out: 0.3 } },
        { id: "@cf/qwen/qwen3-30b-a3b-fp8", tags: ["fast", "tools"], priority: 24, price: { in: 0.051, out: 0.335 } },
        { id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast", tags: ["fast"], priority: 22, price: { in: 0.045, out: 0.384 } },
        { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", tags: ["tools", "structured"], priority: 20, price: { in: 0.293, out: 2.253 } },
      ],
    },
  ],
};

export function splitKeys(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function costUsd(price: ModelDef["price"], inTok: number, outTok: number): number {
  if (!price) return 0;
  return (inTok * price.in + outTok * price.out) / 1_000_000;
}

export function validateCatalog(input: unknown): Catalog {
  const c = input as Catalog;
  const fail = (msg: string): never => {
    throw new Error(`Invalid catalog: ${msg}`);
  };
  if (!c || typeof c !== "object") fail("expected an object");
  if (typeof c.safetyMargin !== "number" || c.safetyMargin <= 0 || c.safetyMargin > 1) fail("safetyMargin must be in (0, 1]");
  if (!Array.isArray(c.globalLimits)) fail("globalLimits must be an array");
  if (!Array.isArray(c.providers)) fail("providers must be an array");
  const windows = new Set(["minute", "hour", "day", "month"]);
  const checkLimits = (limits: unknown, where: string) => {
    if (limits === undefined) return;
    if (!Array.isArray(limits)) fail(`${where}.limits must be an array`);
    for (const l of limits as Limit[]) if (!windows.has(l.window)) fail(`${where}: bad window "${l.window}"`);
  };
  checkLimits(c.globalLimits, "globalLimits");
  const ids = new Set<string>();
  for (const p of c.providers) {
    if (!p.id || !p.keyEnv || !p.directUrl) fail(`provider needs id, keyEnv, directUrl (${JSON.stringify(p.id)})`);
    if (ids.has(p.id)) fail(`duplicate provider id ${p.id}`);
    ids.add(p.id);
    if (!Array.isArray(p.models)) fail(`${p.id}.models must be an array`);
    if (p.modelIdPattern) {
      try {
        new RegExp(p.modelIdPattern);
      } catch {
        fail(`${p.id}.modelIdPattern is not a valid regex`);
      }
    }
    checkLimits(p.limits, p.id);
    for (const m of p.models) {
      if (!m.id) fail(`${p.id} has a model without id`);
      checkLimits(m.limits, `${p.id}/${m.id}`);
    }
  }
  return c;
}
