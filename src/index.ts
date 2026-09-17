import { splitKeys } from "./catalog";
import type { Env } from "./env";
import { cloudflareAccount, type CloudflareAccount } from "./account";
import { sha256Hex } from "./keystore";
import type { Route, SettleInput, StoredChat } from "./tracker";

export { Tracker } from "./tracker";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, x-forager-exclude",
  "access-control-expose-headers": "x-routed-via, x-forager-attempts, x-forager-gateway, cf-aig-log-id, retry-after",
};

// Longest `retry-after` we send a client. Cooldowns and cycle resets can be a day or a month away,
// and OpenAI-compatible SDKs sleep for the advertised time with no upper bound, so the real figure
// would hang an agent run rather than fail it. The exact wait stays in the body as
// `error.retry_after_seconds`, and the dashboard reads cooldowns from the tracker directly.
const MAX_RETRY_AFTER = 60;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // "/" (landing page) and "/dashboard" are static assets in ./public, served before the Worker runs.
    if (path === "/health") return json({ ok: true });
    if (path === "/api/waitlist") return waitlistSignup(request, env);
    if (path === "/api/event") return landingEvent(request, env);
    if (path === "/api/stats" && request.method === "GET") {
      const stats = await env.TRACKER.get(env.TRACKER.idFromName("global")).publicStats();
      return new Response(JSON.stringify(stats), {
        headers: { ...WAITLIST_CORS, "content-type": "application/json", "cache-control": "public, max-age=600" },
      });
    }

    const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));

    // First-run setup, used by the dashboard before anyone owns this Forager.
    if (path === "/api/setup") {
      if (request.method === "GET") return json(await tracker.setupStatus());
      if (request.method === "POST") {
        const result = await tracker.claim();
        return "error" in result ? apiError(result.status, result.error, "setup_error") : json(result, 201);
      }
    }

    const isAdmin = path.startsWith("/admin/");
    if (!(await authorized(request, env, tracker, isAdmin))) {
      const { claimed } = await tracker.setupStatus();
      return apiError(
        401,
        claimed ? "Invalid API key." : "This Forager isn't set up yet. Open /dashboard to create your API key.",
        "authentication_error",
      );
    }
    try {
      if (path === "/v1/chat/completions" && request.method === "POST") return await chatCompletions(request, env, ctx);
      if (path === "/v1/models" && request.method === "GET") {
        const models = await tracker.listModels();
        return json({ object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.owned_by, tags: m.tags })) });
      }
      if (path === "/api/chats" || path.startsWith("/api/chats/")) return await chatHistory(request, env, tracker, path);

      if (path === "/admin/usage" && request.method === "GET") return json(await tracker.usage());
      if (path === "/admin/catalog") {
        if (request.method === "GET") return json(await tracker.getCatalog());
        if (request.method === "PUT") return json(await tracker.setCatalog(await request.json()));
        if (request.method === "DELETE") return json(await tracker.resetCatalog());
      }
      if (path === "/admin/sync" && request.method === "POST") return json(await tracker.syncOpenRouter());
      if (path === "/admin/reset" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { match?: string };
        return json(await tracker.resetCounters(body.match));
      }
      if (path === "/admin/probe" && request.method === "GET") return json(await tracker.probe());
      if (path === "/admin/interest" && request.method === "GET") return json(await tracker.interest());
      if (path === "/admin/interest/sync" && request.method === "POST") return json(await tracker.syncGitHub());
      if (path === "/admin/interest/events" && request.method === "PATCH") {
        return json(await tracker.adjustEvent((await request.json().catch(() => ({}))) as { day?: string; name?: string; delta?: number }));
      }
      if (path === "/admin/waitlist") {
        if (request.method === "GET") return json(await tracker.waitlist());
        if (request.method === "DELETE") {
          const body = (await request.json().catch(() => ({}))) as { email?: string };
          return json(await tracker.removeFromWaitlist(String(body.email ?? "").trim().toLowerCase()));
        }
      }
      if (path === "/admin/router-keys") {
        if (request.method === "GET") return json(await tracker.listRouterKeys());
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { label?: string };
          return json(await tracker.createRouterKey(body.label), 201);
        }
      }
      if (path.startsWith("/admin/router-keys/") && request.method === "DELETE") {
        const result = await tracker.revokeRouterKey(decodeURIComponent(path.slice("/admin/router-keys/".length)));
        routerKeyCache.clear();
        return "error" in result ? apiError(result.status, result.error) : json(result);
      }
      if (path === "/admin/keys") {
        if (request.method === "GET") return json(await tracker.listKeys());
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { provider?: string; key?: string; label?: string };
          return json(await tracker.addKey(body), 201);
        }
      }
      if (path.startsWith("/admin/keys/") && request.method === "DELETE") {
        return json(await tracker.deleteKey(decodeURIComponent(path.slice("/admin/keys/".length))));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const clientError = /^Invalid catalog|^Unknown provider|^That doesn't look|already configured|^Key storage/.test(message);
      return apiError(clientError ? 400 : 500, message);
    }
    return apiError(404, `No route for ${request.method} ${path}`, "not_found");
  },

  async scheduled(_controller, env, ctx) {
    const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));
    ctx.waitUntil(tracker.maintenance());
  },
} satisfies ExportedHandler<Env>;

// ------------------------------------------------------------------ waitlist

const WAITLIST_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** Anonymous landing-page event counter (sent with navigator.sendBeacon). Nothing about the visitor is stored. */
async function landingEvent(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: WAITLIST_CORS });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: WAITLIST_CORS });
  const name = (await request.text()).trim().slice(0, 40);
  const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));
  await tracker.recordEvent({ name, client: await clientHash(request, env) });
  return new Response(null, { status: 204, headers: WAITLIST_CORS });
}

/** Random per-isolate salt for installs without secrets, so IP hashes can't be reversed by brute force. */
let isolateSalt: string | undefined;

/** Short, daily-salted hash of the caller's IP, used only for rate limiting. */
async function clientHash(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const salt = `${env.KEYSTORE_SECRET ?? env.PROXY_API_KEY ?? (isolateSalt ??= crypto.randomUUID())}:${new Date().toISOString().slice(0, 10)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Public hosted-beta signup. No auth; protected by a honeypot field, validation and a per-IP rate limit. */
async function waitlistSignup(request: Request, env: Env): Promise<Response> {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...WAITLIST_CORS, "content-type": "application/json" } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: WAITLIST_CORS });
  if (request.method !== "POST") return reply(405, { error: "Use POST." });

  let data: Record<string, unknown> = {};
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) data = await request.json();
    else data = Object.fromEntries((await request.formData()).entries());
  } catch {
    return reply(400, { error: "Couldn't read the form." });
  }

  // Bots fill every field; people never see this one. Pretend it worked.
  if (String(data.website ?? "").trim()) return reply(200, { ok: true });

  const email = String(data.email ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return reply(400, { error: "Please enter a valid email address." });
  }

  const client = await clientHash(request, env);
  const origin = request.headers.get("origin") ?? "";
  let originHost = "direct";
  try {
    if (origin) originHost = new URL(origin).host || "direct";
  } catch {
    // "null" or malformed Origin header
  }
  const source = String(data.source ?? "").trim() || originHost;

  const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));
  if (data.action === "remove") {
    const removed = await tracker.leaveWaitlist({ email, client });
    return "error" in removed ? reply(removed.status, { error: removed.error }) : reply(200, { ok: true });
  }
  const result = await tracker.joinWaitlist({ email, source, client });
  return "error" in result ? reply(result.status, { error: result.error }) : reply(200, { ok: true });
}

// ------------------------------------------------------------------ chat

/** The OpenAI usage block, including the cache-hit detail providers report. */
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatBody {
  model?: string;
  messages?: { role: string; content: unknown }[];
  tools?: unknown[];
  response_format?: { type?: string };
  stream?: boolean;
  stream_options?: Record<string, unknown>;
  max_tokens?: number;
  max_completion_tokens?: number;
  [k: string]: unknown;
}

interface Attempt {
  route: string;
  status: number;
  error: string;
}

async function chatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ChatBody;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "Request body must be JSON.");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return apiError(400, "`messages` must be a non-empty array.");

  const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));
  const stream = body.stream === true;
  const needs = {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision: hasImages(body.messages),
    // Only strict schemas gate routing. Plain `json_object` is a hint most models honour loosely,
    // and gating on it would shrink the pool for requests that tolerate a stray prose wrapper.
    structured: body.response_format?.type === "json_schema",
  };
  const estIn = estimateTokens(JSON.stringify(body.messages)) + (needs.tools ? estimateTokens(JSON.stringify(body.tools)) : 0);
  const estOut = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 1024) || 1024, 4096);
  const maxAttempts = Number(env.MAX_ATTEMPTS ?? 6);
  // The timeout covers response headers only. Streams send headers before the first token, so they
  // get a shorter wait; non-streaming headers arrive only after the whole answer is generated.
  const streamTimeoutMs = Number(env.UPSTREAM_STREAM_TIMEOUT_MS ?? 15_000);
  const plainTimeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? 30_000);

  const account = await cloudflareAccount(env);
  // A client can rule out models it has already found unusable for this job, with
  // `x-forager-exclude: provider/model, provider/model`. Forager only sees HTTP: a reply that
  // parses fine but fails the caller's own validation still looks like a success here, so without
  // this an agent retrying a bad answer gets the same top-priority model back and loops.
  const exclude: string[] = clientExclusions(request);
  const attempts: Attempt[] = [];
  let lastUpstream: { status: number; body: string; headers: Headers } | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const acquired = await tracker.acquire({ model: body.model ?? "auto", needs, estIn, estOut, exclude });
    if ("error" in acquired) {
      if (lastUpstream && attempts.length === 1 && lastUpstream.status < 500 && lastUpstream.status !== 429) {
        // Single explicit model failed with a client error: pass the provider's answer through.
        return new Response(lastUpstream.body, { status: lastUpstream.status, headers: { ...CORS, "content-type": "application/json" } });
      }
      const headers: Record<string, string> = {};
      // OpenAI-compatible clients obey `retry-after` literally: the OpenAI SDKs sleep for exactly
      // that long with no ceiling, and their sleep isn't abortable, so a caller that hits a day or
      // month reset (or a provider cooldown built from an upstream "come back tomorrow" 429) parks
      // for hours instead of failing. Cap the header and report the real wait in the body.
      if (acquired.retryAfter) headers["retry-after"] = String(Math.min(acquired.retryAfter, MAX_RETRY_AFTER));
      const status = attempts.length ? 502 : acquired.status;
      const extra: Record<string, unknown> = { attempts, blocked: acquired.blocked };
      if (acquired.retryAfter) extra.retry_after_seconds = acquired.retryAfter;
      return apiError(status, acquired.error, status === 502 ? "upstream_error" : undefined, extra, headers);
    }

    const route = acquired.route;
    const key = route.key;
    const target = upstreamTarget(account, route);
    // `collect`: the client wants one JSON body, but this provider is only fast when streaming.
    const collect = !stream && route.forceStream;
    const upstreamStream = stream || collect;
    const upstreamBody: ChatBody = { ...body, model: target.model, ...(collect ? { stream: true } : {}) };
    if (upstreamStream && route.streamUsage) upstreamBody.stream_options = { ...body.stream_options, include_usage: true };

    const headers: Record<string, string> = { "content-type": "application/json", ...route.headers };
    if (key) headers.authorization = `Bearer ${key}`;
    if (target.viaGateway) {
      if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
      if (env.GATEWAY_CACHE_TTL) headers["cf-aig-cache-ttl"] = env.GATEWAY_CACHE_TTL;
      headers["cf-aig-metadata"] = JSON.stringify({ route: `${route.provider}/${route.model}`, key: route.keyIndex });
    }

    const started = Date.now();
    const abort = new AbortController();
    const timeoutMs = route.timeoutMs ?? (upstreamStream ? streamTimeoutMs : plainTimeoutMs);
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(target.url, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal: abort.signal });
    } catch (e) {
      clearTimeout(timer);
      const reason = abort.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${e instanceof Error ? e.message : e}`;
      await tracker.settle({ route, ok: false, status: 599, latencyMs: Date.now() - started, cooldownMs: 30_000, cooldownScope: "model", reason, escalate: true });
      exclude.push(`${route.provider}/${route.model}`);
      attempts.push({ route: route.routeId, status: 599, error: reason });
      continue;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      if (target.viaGateway && text.includes("AiGatewayError")) {
        // The gateway itself refused us, not the provider: don't punish the provider key. Retry this
        // model directly and skip the gateway for 10 minutes.
        console.warn(`AI Gateway "${env.AI_GATEWAY_ID}" rejected a request (HTTP ${res.status}); calling providers directly. ${text.slice(0, 200)}`);
        gatewayBypassUntil = Date.now() + 600_000;
        await tracker.settle({ route, ok: false, status: res.status, latencyMs: Date.now() - started });
        i--;
        continue;
      }
      const policy = failurePolicy(res.status, res.headers, text);
      await tracker.settle({
        route,
        ok: false,
        status: res.status,
        latencyMs: Date.now() - started,
        cooldownMs: policy.cooldownMs,
        cooldownScope: policy.scope,
        reason: `HTTP ${res.status}`,
        escalate: res.status === 408 || res.status >= 500,
      });
      exclude.push(policy.skipModel ? `${route.provider}/${route.model}` : route.routeId);
      attempts.push({ route: route.routeId, status: res.status, error: text.slice(0, 300) });
      lastUpstream = { status: res.status, body: text, headers: res.headers };
      continue;
    }

    // Success. Learn from rate-limit headers so the next request avoids an exhausted key.
    const learned = headerCooldown(res.headers);
    const outHeaders: Record<string, string> = {
      ...CORS,
      "x-routed-via": `${route.provider}/${route.model}`,
      "x-forager-attempts": String(attempts.length + 1),
      "x-forager-gateway": target.viaGateway ? "used" : route.gateway ? "bypassed" : "not-used",
    };
    const logId = res.headers.get("cf-aig-log-id");
    if (logId) outHeaders["cf-aig-log-id"] = logId;

    const settle = (inTok: number | undefined, outTok: number | undefined, cachedTok?: number): Promise<void> =>
      tracker.settle({
        route,
        ok: true,
        status: res.status,
        inTok,
        outTok,
        cachedTok,
        latencyMs: Date.now() - started,
        cooldownMs: learned,
        cooldownScope: "route",
        reason: "provider reported quota exhausted",
      } satisfies SettleInput);

    const contentType = res.headers.get("content-type") ?? "";
    if (stream && res.body && contentType.includes("text/event-stream")) {
      const tap = tapSse(res.body);
      ctx.waitUntil(
        tap.done.then(({ usage, chars }) =>
          settle(
            usage?.prompt_tokens ?? estIn,
            usage?.completion_tokens ?? Math.ceil(chars / 4),
            usage?.prompt_tokens_details?.cached_tokens,
          ),
        ),
      );
      return new Response(tap.stream, {
        headers: { ...outHeaders, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    if (collect && res.body && contentType.includes("text/event-stream")) {
      const collected = await collectSse(res.body);
      if (collected.error !== undefined) {
        // The provider accepted the request and then streamed an error instead of an answer.
        // Nothing has reached the client, so treat it like a failed call and try the next model.
        const reason = collected.error.slice(0, 300);
        await tracker.settle({ route, ok: false, status: 502, latencyMs: Date.now() - started, cooldownMs: 30_000, cooldownScope: "model", reason, escalate: true });
        exclude.push(`${route.provider}/${route.model}`);
        attempts.push({ route: route.routeId, status: 502, error: `error event in stream: ${reason}` });
        continue;
      }
      const { usage } = collected;
      ctx.waitUntil(
        settle(usage?.prompt_tokens ?? estIn, usage?.completion_tokens ?? Math.ceil(collected.chars / 4), usage?.prompt_tokens_details?.cached_tokens),
      );
      return new Response(JSON.stringify(collected.completion), {
        status: 200,
        headers: { ...outHeaders, "content-type": "application/json", "x-forager-collected": "stream" },
      });
    }

    const text = await res.text();
    let usage: Usage | undefined;
    let outChars = text.length;
    try {
      const parsed = JSON.parse(text) as { usage?: typeof usage; choices?: { message?: unknown }[] };
      usage = parsed.usage;
      outChars = JSON.stringify(parsed.choices?.map((c) => c.message) ?? "").length;
    } catch {
      // Non-JSON success body: estimate from size.
    }
    ctx.waitUntil(
      settle(
        usage?.prompt_tokens ?? estIn,
        usage?.completion_tokens ?? Math.ceil(outChars / 4),
        usage?.prompt_tokens_details?.cached_tokens,
      ),
    );
    return new Response(text, { status: res.status, headers: { ...outHeaders, "content-type": contentType || "application/json" } });
  }

  return apiError(502, `Gave up after ${maxAttempts} attempts.`, "upstream_error", { attempts });
}

/**
 * When the gateway itself rejects requests (missing, or Authenticated Gateway without CF_AIG_TOKEN),
 * providers are called directly for a while instead, so a fresh deploy works before AI Gateway is set up.
 */
let gatewayBypassUntil = 0;

function upstreamTarget(account: CloudflareAccount, route: Route): { url: string; model: string; viaGateway: boolean } {
  const base = account.gatewayBase;
  if (route.gateway && base && Date.now() >= gatewayBypassUntil) {
    if (route.gateway.mode === "compat") {
      return { url: `${base}/compat/chat/completions`, model: `${route.gateway.slug}/${route.model}`, viaGateway: true };
    }
    return { url: `${base}/${route.gateway.path.replace(/^\/+/, "")}`, model: route.model, viaGateway: true };
  }
  return { url: route.directUrl.replace("{ACCOUNT_ID}", account.accountId ?? ""), model: route.model, viaGateway: false };
}

/** What to do after a failed upstream call. */
function failurePolicy(status: number, headers: Headers, body: string): { cooldownMs?: number; scope: "key" | "route" | "model"; skipModel: boolean } {
  // Billing/credit problems sometimes arrive as 429 (e.g. Gemini "prepayment credits are depleted").
  // Treat them like 402: the key is tied to paid billing, so keep away from it for a day.
  if (status === 429 && /credits? (are |is )?depleted|prepay|billing|payment required|insufficient (credits|balance|funds)/i.test(body)) {
    return { cooldownMs: 86_400_000, scope: "key", skipModel: false };
  }
  if (status === 429) {
    const retry = parseDuration(headers.get("retry-after")) ?? headerCooldown(headers);
    // Daily/monthly quota messages deserve a long pause; per-minute throttles a short one.
    const long = /per day|daily|per month|monthly|quota|FreeUsageLimit/i.test(body) ? 3_600_000 : 60_000;
    return { cooldownMs: Math.max(retry ?? long, 5_000), scope: "route", skipModel: false };
  }
  // A model outside the plan (Ollama "requires a subscription", Mistral "tier_not_allowed", OpenRouter
  // "only available on agentic harnesses") only parks that model, not every model on the key.
  if (status === 403 && /subscription|tier|not available|only available|not allowed|upgrade|plan/i.test(body)) {
    return { cooldownMs: 86_400_000, scope: "model", skipModel: true };
  }
  if (status === 401 || status === 403) return { cooldownMs: 3_600_000, scope: "key", skipModel: false };
  // 402 = credits/billing problem. Never retry this key for a day: protects the $0 promise.
  if (status === 402) return { cooldownMs: 86_400_000, scope: "key", skipModel: false };
  if (status === 404) return { cooldownMs: 6 * 3_600_000, scope: "model", skipModel: true };
  if (status === 408 || status >= 500) return { cooldownMs: 30_000, scope: "model", skipModel: true };
  // 400/413/422…: request-specific (unsupported param, too long). Try another model, no cooldown.
  return { scope: "model", skipModel: true };
}

/** If a provider says a quota is already at zero, returns ms until it resets. */
function headerCooldown(headers: Headers): number | undefined {
  let cooldown: number | undefined;
  for (const kind of ["requests", "tokens"]) {
    const remaining = headers.get(`x-ratelimit-remaining-${kind}`);
    if (remaining === null || Number(remaining) > 0) continue;
    const wait = parseDuration(headers.get(`x-ratelimit-reset-${kind}`)) ?? 60_000;
    cooldown = Math.max(cooldown ?? 0, wait);
  }
  return cooldown;
}

/** Parses "30", "2m59.5s", "150ms", epoch seconds/ms, or an HTTP date into milliseconds from now. */
function parseDuration(value: string | null): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return Math.max(0, n - Date.now());
    if (n > 1e9) return Math.max(0, n * 1000 - Date.now());
    return n * 1000;
  }
  let total = 0;
  let matched = false;
  for (const [, num, unit] of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(num) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as "ms" | "s" | "m" | "h"];
  }
  if (matched) return Math.ceil(total);
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Passes an SSE stream through untouched while capturing the final usage block. */
function tapSse(body: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  done: Promise<{ usage?: Usage; chars: number }>;
} {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | undefined;
  let chars = 0;

  const scan = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const event = JSON.parse(data) as { usage?: typeof usage; choices?: { delta?: Record<string, unknown> }[] };
      if (event.usage) usage = event.usage;
      for (const choice of event.choices ?? []) {
        const d = choice.delta ?? {};
        for (const field of ["content", "reasoning", "reasoning_content"]) {
          if (typeof d[field] === "string") chars += (d[field] as string).length;
        }
        if (d.tool_calls) chars += JSON.stringify(d.tool_calls).length;
      }
    } catch {
      // Ignore keep-alives and non-JSON events.
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        scan(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush() {
      buffer += decoder.decode();
      if (buffer) scan(buffer);
    },
  });

  // Resolves on completion *or* client disconnect, so usage is always settled.
  const done = body
    .pipeTo(transform.writable)
    .catch(() => undefined)
    .then(() => ({ usage, chars }));
  return { stream: transform.readable, done };
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface CollectedChoice {
  index: number;
  message: Record<string, unknown> & { role: string; content: string | null; tool_calls?: ToolCallDelta[] };
  finish_reason: string | null;
}

/**
 * Reads a whole chat.completion SSE stream and rebuilds the non-streaming response: text fields
 * concatenated per choice, tool call fragments merged by index, the last usage block kept.
 * `error` is set when the stream carried an error event and produced no answer.
 */
async function collectSse(body: ReadableStream<Uint8Array>): Promise<{
  completion: Record<string, unknown>;
  usage?: Usage;
  chars: number;
  error?: string;
}> {
  const choices = new Map<number, CollectedChoice>();
  const meta: Record<string, unknown> = {};
  let usage: Usage | undefined;
  let chars = 0;
  let error: string | undefined;

  const scan = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event: {
      id?: string;
      created?: number;
      model?: string;
      system_fingerprint?: string;
      usage?: Usage;
      error?: unknown;
      choices?: { index?: number; delta?: Record<string, unknown>; finish_reason?: string | null }[];
    };
    try {
      event = JSON.parse(data);
    } catch {
      return; // keep-alives and non-JSON events
    }
    if (event.error !== undefined) error = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
    for (const field of ["id", "created", "model", "system_fingerprint"] as const) {
      if (event[field] !== undefined && meta[field] === undefined) meta[field] = event[field];
    }
    if (event.usage) usage = event.usage;
    for (const part of event.choices ?? []) {
      const index = part.index ?? 0;
      let choice = choices.get(index);
      if (!choice) {
        choice = { index, message: { role: "assistant", content: null }, finish_reason: null };
        choices.set(index, choice);
      }
      if (part.finish_reason) choice.finish_reason = part.finish_reason;
      const delta = part.delta ?? {};
      for (const [field, value] of Object.entries(delta)) {
        if (field === "role") {
          if (typeof value === "string") choice.message.role = value;
        } else if (field === "tool_calls" && Array.isArray(value)) {
          const calls = (choice.message.tool_calls ??= []);
          for (const fragment of value as ToolCallDelta[]) {
            const at = fragment.index ?? calls.length;
            const call = (calls[at] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
            if (fragment.id) call.id = fragment.id;
            if (fragment.type) call.type = fragment.type;
            if (fragment.function?.name) call.function!.name += fragment.function.name;
            if (fragment.function?.arguments) call.function!.arguments += fragment.function.arguments;
            chars += JSON.stringify(fragment).length;
          }
        } else if (typeof value === "string") {
          // content, reasoning, reasoning_content, refusal: whatever text fields the provider streams.
          choice.message[field] = ((choice.message[field] as string | null) ?? "") + value;
          chars += value.length;
        }
      }
    }
  };

  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      scan(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer) scan(buffer);

  const list = [...choices.values()].sort((a, b) => a.index - b.index);
  for (const choice of list) {
    if (choice.message.tool_calls) choice.message.tool_calls = choice.message.tool_calls.filter(Boolean);
  }
  const answered = list.some((c) => c.message.content || c.message.tool_calls?.length);
  return {
    completion: {
      id: meta.id ?? `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: meta.created ?? Math.floor(Date.now() / 1000),
      model: meta.model,
      ...(meta.system_fingerprint ? { system_fingerprint: meta.system_fingerprint } : {}),
      choices: list,
      ...(usage ? { usage } : {}),
    },
    usage,
    chars,
    error: error !== undefined && !answered ? error : undefined,
  };
}

function hasImages(messages: { content: unknown }[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => (part as { type?: string })?.type === "image_url"),
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ------------------------------------------------------------------ admin helpers

/** Per-isolate cache of router-key checks, so most requests skip the Durable Object round trip. */
const routerKeyCache = new Map<string, { ok: boolean; until: number }>();

/**
 * Accepts keys from the PROXY_API_KEY secret (or ADMIN_API_KEY for /admin) and API keys created in the
 * dashboard. Dashboard keys are stored as SHA-256 hashes; revoking one takes effect within a minute.
 */
/**
 * Chat history for /chat, scoped to the API key that saved it. Disabled unless CHAT_HISTORY is set,
 * so a plain deploy (and anyone else's copy of Forager) keeps chats in the browser only.
 */
async function chatHistory(
  request: Request,
  env: Env,
  tracker: DurableObjectStub<import("./tracker").Tracker>,
  path: string,
): Promise<Response> {
  if (!env.CHAT_HISTORY) return apiError(404, "Chat history isn't enabled on this Forager.", "not_found");

  const owner = await sha256Hex(bearerToken(request));
  const id = path.startsWith("/api/chats/") ? decodeURIComponent(path.slice("/api/chats/".length)) : "";

  if (id) {
    if (request.method !== "DELETE") return apiError(405, "Method not allowed.");
    return json(await tracker.deleteChat(owner, id));
  }
  if (request.method === "GET") return json(await tracker.listChats(owner));
  if (request.method === "DELETE") return json(await tracker.deleteChats(owner));
  if (request.method === "PUT") {
    const body = (await request.json().catch(() => null)) as { chats?: unknown } | null;
    const chats = cleanChats(body?.chats);
    if (!chats) return apiError(400, "Send { chats: [...] } with at most 20 chats of 200 messages each.");
    return json(await tracker.saveChats(owner, chats));
  }
  return apiError(405, "Method not allowed.");
}

/** Keeps stored chats to a sane shape and size; anything unexpected makes the whole request fail. */
function cleanChats(input: unknown): StoredChat[] | null {
  if (!Array.isArray(input) || input.length > 20) return null;
  const chats: StoredChat[] = [];
  for (const raw of input) {
    const c = raw as Partial<StoredChat>;
    if (!c || typeof c.id !== "string" || !c.id || c.id.length > 64) return null;
    if (!Array.isArray(c.messages) || c.messages.length > 200) return null;
    const messages = c.messages.map((m) => ({
      role: String((m as { role?: unknown }).role ?? "user").slice(0, 20),
      content: String((m as { content?: unknown }).content ?? "").slice(0, 100_000),
      meta: (m as { meta?: unknown }).meta,
      error: (m as { error?: unknown }).error === true ? true : undefined,
    }));
    chats.push({
      id: c.id,
      title: String(c.title ?? "New chat").slice(0, 200),
      model: String(c.model ?? "").slice(0, 120),
      updated: Number.isFinite(c.updated) ? Number(c.updated) : Date.now(),
      messages,
    });
  }
  return chats;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  return (header?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-api-key") ?? "").trim();
}

async function authorized(request: Request, env: Env, tracker: DurableObjectStub<import("./tracker").Tracker>, admin: boolean): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;

  const secretKeys = admin ? (env.ADMIN_API_KEY ?? env.PROXY_API_KEY) : env.PROXY_API_KEY;
  const enc = new TextEncoder();
  const a = enc.encode(token);
  const matchesSecret = splitKeys(secretKeys).some((k) => {
    const b = enc.encode(k);
    return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
  });
  if (matchesSecret) return true;
  // With ADMIN_API_KEY set, only that key may use /admin.
  if (admin && env.ADMIN_API_KEY) return false;
  if (!/^fgr_[0-9a-f]{64}$/.test(token)) return false;

  const hash = await sha256Hex(token);
  const now = Date.now();
  const cached = routerKeyCache.get(hash);
  if (cached && cached.until > now) return cached.ok;
  const ok = await tracker.hasRouterKey(hash);
  if (routerKeyCache.size > 1000) routerKeyCache.clear();
  routerKeyCache.set(hash, { ok, until: now + (ok ? 60_000 : 10_000) });
  return ok;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...CORS, "content-type": "application/json", ...headers } });
}

/**
 * Models the client has asked us to skip, from `x-forager-exclude`.
 *
 * Entries match the same `provider/model` form as the `model` field (a bare route id works too).
 * Bounded so a malformed header can't blow up the candidate scan; unknown names are harmless
 * because `acquire()` just never matches them.
 */
function clientExclusions(request: Request): string[] {
  const header = request.headers.get("x-forager-exclude");
  if (!header) return [];
  const seen = new Set<string>();
  for (const part of header.split(",")) {
    const name = part.trim();
    if (name && name.length <= 120) seen.add(name);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

function apiError(status: number, message: string, type = status === 429 ? "rate_limit_exceeded" : "invalid_request_error", extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ error: { message, type, ...extra } }, status, headers);
}
