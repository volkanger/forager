import { splitKeys } from "./catalog";
import type { Env } from "./env";
import { cloudflareAccount, type CloudflareAccount } from "./account";
import type { Route, SettleInput } from "./tracker";

export { Tracker } from "./tracker";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key",
  "access-control-expose-headers": "x-routed-via, x-forager-attempts, x-forager-gateway, cf-aig-log-id, retry-after",
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // "/" (landing page) and "/dashboard" are static assets in ./public, served before the Worker runs.
    if (path === "/health") return json({ ok: true });
    if (path === "/api/waitlist") return waitlistSignup(request, env);

    if (!env.PROXY_API_KEY) return apiError(500, "PROXY_API_KEY secret is not set; refusing to run an open proxy.");
    const isAdmin = path.startsWith("/admin/");
    if (!(await authorized(request, isAdmin ? (env.ADMIN_API_KEY ?? env.PROXY_API_KEY) : env.PROXY_API_KEY))) {
      return apiError(401, "Invalid API key.", "authentication_error");
    }

    const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));
    try {
      if (path === "/v1/chat/completions" && request.method === "POST") return await chatCompletions(request, env, ctx);
      if (path === "/v1/models" && request.method === "GET") {
        const models = await tracker.listModels();
        return json({ object: "list", data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.owned_by, tags: m.tags })) });
      }
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
      if (path === "/admin/waitlist") {
        if (request.method === "GET") return json(await tracker.waitlist());
        if (request.method === "DELETE") {
          const body = (await request.json().catch(() => ({}))) as { email?: string };
          return json(await tracker.removeFromWaitlist(String(body.email ?? "").trim().toLowerCase()));
        }
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
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

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

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const salt = `${env.KEYSTORE_SECRET ?? env.PROXY_API_KEY ?? ""}:${new Date().toISOString().slice(0, 10)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  const client = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const origin = request.headers.get("origin") ?? "";
  let originHost = "direct";
  try {
    if (origin) originHost = new URL(origin).host || "direct";
  } catch {
    // "null" or malformed Origin header
  }
  const source = String(data.source ?? "").trim() || originHost;

  const tracker = env.TRACKER.get(env.TRACKER.idFromName("global"));
  const result = await tracker.joinWaitlist({ email, source, client });
  return "error" in result ? reply(result.status, { error: result.error }) : reply(200, { ok: true });
}

// ------------------------------------------------------------------ chat

interface ChatBody {
  model?: string;
  messages?: { role: string; content: unknown }[];
  tools?: unknown[];
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
  const needs = { tools: Array.isArray(body.tools) && body.tools.length > 0, vision: hasImages(body.messages) };
  const estIn = estimateTokens(JSON.stringify(body.messages)) + (needs.tools ? estimateTokens(JSON.stringify(body.tools)) : 0);
  const estOut = Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 1024) || 1024, 4096);
  const maxAttempts = Number(env.MAX_ATTEMPTS ?? 6);
  const defaultTimeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? 30_000);

  const account = await cloudflareAccount(env);
  const exclude: string[] = [];
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
      if (acquired.retryAfter) headers["retry-after"] = String(acquired.retryAfter);
      const status = attempts.length ? 502 : acquired.status;
      return apiError(status, acquired.error, status === 502 ? "upstream_error" : undefined, { attempts, blocked: acquired.blocked }, headers);
    }

    const route = acquired.route;
    const key = route.key;
    const target = upstreamTarget(account, route);
    const upstreamBody: ChatBody = { ...body, model: target.model };
    if (stream && route.streamUsage) upstreamBody.stream_options = { ...body.stream_options, include_usage: true };

    const headers: Record<string, string> = { "content-type": "application/json", ...route.headers };
    if (key) headers.authorization = `Bearer ${key}`;
    if (target.viaGateway) {
      if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
      if (env.GATEWAY_CACHE_TTL) headers["cf-aig-cache-ttl"] = env.GATEWAY_CACHE_TTL;
      headers["cf-aig-metadata"] = JSON.stringify({ route: `${route.provider}/${route.model}`, key: route.keyIndex });
    }

    const started = Date.now();
    const abort = new AbortController();
    const timeoutMs = route.timeoutMs ?? defaultTimeoutMs;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(target.url, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal: abort.signal });
    } catch (e) {
      clearTimeout(timer);
      const reason = abort.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${e instanceof Error ? e.message : e}`;
      await tracker.settle({ route, ok: false, status: 599, latencyMs: Date.now() - started, cooldownMs: 30_000, cooldownScope: "model", reason });
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

    const settle = (inTok: number | undefined, outTok: number | undefined): Promise<void> =>
      tracker.settle({
        route,
        ok: true,
        status: res.status,
        inTok,
        outTok,
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
          settle(usage?.prompt_tokens ?? estIn, usage?.completion_tokens ?? Math.ceil(chars / 4)),
        ),
      );
      return new Response(tap.stream, {
        headers: { ...outHeaders, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    const text = await res.text();
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let outChars = text.length;
    try {
      const parsed = JSON.parse(text) as { usage?: typeof usage; choices?: { message?: unknown }[] };
      usage = parsed.usage;
      outChars = JSON.stringify(parsed.choices?.map((c) => c.message) ?? "").length;
    } catch {
      // Non-JSON success body: estimate from size.
    }
    ctx.waitUntil(settle(usage?.prompt_tokens ?? estIn, usage?.completion_tokens ?? Math.ceil(outChars / 4)));
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
  // A model outside the plan (Ollama "requires a subscription", Mistral "tier_not_allowed") only parks that model.
  if (status === 403 && /subscription|tier|not available|not allowed|upgrade|plan/i.test(body)) {
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
  done: Promise<{ usage?: { prompt_tokens?: number; completion_tokens?: number }; chars: number }>;
} {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
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

function hasImages(messages: { content: unknown }[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => (part as { type?: string })?.type === "image_url"),
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ------------------------------------------------------------------ admin helpers

async function authorized(request: Request, keys: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  const token = header?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-api-key") ?? "";
  if (!token) return false;
  const enc = new TextEncoder();
  const a = enc.encode(token);
  return splitKeys(keys).some((k) => {
    const b = enc.encode(k);
    return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
  });
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...CORS, "content-type": "application/json", ...headers } });
}

function apiError(status: number, message: string, type = status === 429 ? "rate_limit_exceeded" : "invalid_request_error", extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ error: { message, type, ...extra } }, status, headers);
}
