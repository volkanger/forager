# Forager architecture

How the code works, for contributors and for anyone picking the project up later. For setup and usage, see the [README](../README.md).

## The big picture

Forager is one Cloudflare Worker plus one Durable Object:

```
                         ┌──────────────────────── Cloudflare Worker (src/index.ts) ───────────────────────┐
browser ── / , /dashboard ──► static assets (public/)            ◄── served before the Worker runs, free
                         │                                                                                 │
apps ──── /v1/* ─────────► auth ─► acquire() ─► fetch provider ─► settle() ─► response (+ SSE usage tap)   │
                         │           │                 │              │                                    │
dashboard ── /admin/* ───►           │                 │              │                                    │
landing ─── /api/* ──────►           ▼                 ▼              ▼                                    │
                         │   ┌── Tracker Durable Object (src/tracker.ts), one global instance ──┐          │
                         │   │ catalog · quota counters · cooldowns · stats · provider keys    │          │
                         │   │ router API keys · waitlist · interest stats   (SQLite storage)  │          │
                         │   └──────────────────────────────────────────────────────────────────┘          │
                         └─────────────────────────────────────────────────────────────────────────────────┘
                                             │
                     AI Gateway (optional) ──┴── or direct ──► Groq, Gemini, NVIDIA, Mistral, OpenRouter, …
```

- **The Worker** is stateless: routing HTTP, authentication, calling providers, streaming responses back.
- **The Tracker Durable Object** (`idFromName("global")`) is the only state. Because a Durable Object processes one event at a time, quota checks and reservations can't race each other.
- **Static assets** in `public/` (landing page and dashboard) are served by Cloudflare before the Worker runs, so they cost nothing and don't count against Worker limits.

## Files

| File | Responsibility |
|---|---|
| `src/index.ts` | HTTP routes, auth, the chat proxy loop with failover, SSE usage tap, failure policy, waitlist and event endpoints |
| `src/tracker.ts` | Durable Object: routing decisions, quota counters, cooldowns, stats, catalog overrides, encrypted provider keys, router API keys, waitlist, GitHub interest sync |
| `src/catalog.ts` | Types and the default provider/model catalog with free-tier limits; catalog validation |
| `src/cycles.ts` | Quota cycle ids (minute, hour, day, month) and reset times, per time zone |
| `src/keystore.ts` | AES-256-GCM seal/unseal, key import, random hex, SHA-256 helpers |
| `src/account.ts` | Discovers the Cloudflare account ID through the Workers AI binding (so config has nothing account-specific) |
| `src/env.ts` | The `Env` type: bindings, vars, optional secrets |
| `public/index.html` | Landing page (fora.ger.soy): Deploy button, catalog, waitlist, star count, click beacons, self-host redirect to setup |
| `public/dashboard.html` | Dashboard: first-run setup, API keys, provider keys, quota bars, cooldowns, stats, playground, waitlist, interest |
| `scripts/import-freellmapi-keys.mjs` | Copies keys from a local FreeLLMAPI install into Wrangler secrets (decrypts in memory, pipes to `wrangler secret bulk`) |
| `scripts/publish-public.sh` | Publishes the private repo's HEAD to the public repo as one new commit |
| `wrangler.jsonc` | Worker config: assets, Durable Object + migration, AI binding, cron, `AI_GATEWAY_ID` |

## A chat request, step by step

`POST /v1/chat/completions` in `chatCompletions()`:

1. **Auth** (`authorized()`): the bearer token must match the `PROXY_API_KEY` secret, or be a dashboard-created `fgr_…` key whose SHA-256 hash the Tracker holds. Hash lookups are cached per isolate for 60 s (10 s for misses).
2. **Estimate**: input tokens ≈ JSON length of `messages` (+ `tools`) ÷ 4; output tokens = `max_tokens` (default 1024, capped at 4096). Detect `needs.tools` and `needs.vision` (any `image_url` part).
3. **Acquire** (`Tracker.acquire()`), repeated up to `MAX_ATTEMPTS` (default 6):
   - **Resolve candidates** from the `model` field:
     - `auto`: every allowed model, highest `priority` first.
     - `auto:<tag>`: only models with that tag. `auto:<profile>`: an ordered list from `catalog.profiles`.
     - `provider/model`: exactly that model. A bare model id matches every provider that serves it.
     - For `auto*`, models missing a needed capability or with too small a context window are dropped.
   - **Guards**: disabled providers/models, providers with no key, and model ids failing the provider's `modelIdPattern` (the $0 guard, e.g. OpenRouter `:free$`) never become candidates.
   - **For each candidate and each key slot** (round robin per provider): skip it if excluded for this request or cooling down; otherwise check every limit in three scopes: global (`g`), provider+key (`p:<provider>#<k>`), model+key (`m:<provider>/<model>#<k>`).
   - **First fit wins**: the estimated request, tokens and USD are **reserved** in every scope, and a `Route` goes back to the Worker (including the plaintext provider key, which never leaves the Worker).
   - **Nothing fits**: 429 with a `retry-after` based on the soonest cooldown or cycle reset, and a `blocked` summary of why.
4. **Build the upstream call** (`upstreamTarget()`):
   - **Through AI Gateway** when the provider has a `gateway` route and the account ID resolved: `compat` providers post to `…/compat/chat/completions` with `model: "<slug>/<id>"`; `path` providers use their own gateway path.
   - **Directly** (`directUrl`) otherwise.
   - If the gateway itself rejects a request (an `AiGatewayError` body), the Worker retries that same model directly and bypasses the gateway for 10 minutes.
5. **Fetch** with a timeout on response headers: the provider's `timeoutMs`, or `UPSTREAM_TIMEOUT_MS` (30 s). Streams run as long as needed after headers arrive.
6. **On failure**: `failurePolicy()` decides the cooldown (table below). The Worker calls `settle()` so tokens are refunded (the request stays counted), excludes the key or model, and loops. **Fallback only happens before the first byte is sent.**
7. **On success**:
   - Rate-limit headers that report zero remaining (`x-ratelimit-remaining-*`) become a cooldown until their reset.
   - **Non-streaming**: usage comes from `usage` in the JSON body, or is estimated from the output length.
   - **Streaming**: `stream_options.include_usage` is requested where supported. `tapSse()` passes bytes through untouched while parsing `data:` lines for the final `usage` block, counting output characters as a fallback.
   - **Settle**: `settle()` runs in `ctx.waitUntil()` and corrects every scope from the estimate to real usage. It still runs if the client disconnects mid-stream.
8. **Response headers**: `x-routed-via: provider/model`, `x-forager-attempts`, `x-forager-gateway: used | bypassed | not-used`, plus `cf-aig-log-id` when the gateway logged the request.

### Failure policy

| Upstream result | Cooldown | Scope |
|---|---|---|
| 429 whose body mentions depleted credits, prepay, billing, insufficient balance | 24 h | key |
| 429 mentioning daily/monthly quota or `FreeUsageLimit` | 1 h (or `retry-after`) | route (this model on this key) |
| other 429 | `retry-after`, reset header, or 60 s (min 5 s) | route |
| 403 mentioning subscription, tier, plan, not available | 24 h | model, on every key |
| 401 / other 403 | 1 h | key |
| 402 | 24 h | key |
| 404 | 6 h | model |
| 408, 5xx, network error, timeout | 30 s | model |
| 400, 413, 422… | none; try another model | – |

Cooldown ids: `c:<provider>#<k>` (key), `c:<provider>/<model>#<k>` (route), `c:<provider>/<model>` (model). They're persisted immediately, so a restart doesn't forget a 24 h billing pause.

## Quota cycles and limits

A `Limit` is `{ window: "minute" | "hour" | "day" | "month", requests?, tokens?, usd? }` and can sit on:
- **The catalog** (`globalLimits`): the whole Worker, capped at 30,000 requests/day to stay inside the Workers and Durable Objects free plans.
- **A provider**: shared by all its models, per key. Examples: OpenRouter's 50 requests/day, Mistral's $10/month.
- **A model**, per key. Example: Groq's 1,000 requests/day for each model.

Details:
- **Cycle ids** come from `periodId()`: minute and hour are UTC epoch buckets; day and month use the provider's `resetTz` (Gemini resets at midnight Pacific). `nextReset()` finds the boundary for dashboards and `retry-after`.
- **Safety margin**: a request is refused once `used + estimate > limit × margin`. The margin is `catalog.safetyMargin` (0.9), or at most 0.8 for providers with `requiresCard`.
- **USD metering** uses the model's `price` (USD per 1M tokens). It turns money-based free allowances into limits, e.g. Workers AI's 10,000 neurons/day = $0.11/day, and Mistral's $10/month credit.

## Durable Object data model

SQLite tables (all `WITHOUT ROWID` so an upsert writes one row):

| Table | Contents |
|---|---|
| `counters (id, data)` | Per scope id, JSON `{minute:{p,req,tok,usd}, hour:…, day:…, month:…}` where `p` is the cycle id. A stale `p` reads as zero. |
| `cooldowns (id, until, reason)` | Active pauses |
| `stats (day, provider, model, requests, ok, tok_in, tok_out, usd, latency_ms)` | Daily per-model stats (kept 90 days) |
| `provider_keys (id, provider, label, last4, ciphertext, iv, created_at)` | Provider keys added in the dashboard, AES-256-GCM sealed |
| `waitlist (email, created_at, source)` | Hosted-beta signups |
| `events (day, name, count)` | Anonymous landing-page click counts |
| `github_daily (day, stars, watchers, forks, views, view_uniques, clones, clone_uniques, poll_votes)` | GitHub interest history |
| `kv (k, v)` | `catalog` (runtime override), `openrouter_free` (synced list), `router_keys` (hashed API keys), `first_seen`, `keystore_key` (generated encryption key), `github_synced_at`, `github_referrers`, `github_poll` |

**Write budget:** the free plan allows 100k rows written/day. Counters and stats live in memory and are flushed by an alarm 2 s after the first change (`scheduleFlush()` → `alarm()` → `flush()`), so bursts of requests collapse into a few writes. Cooldowns, keys and waitlist rows are written immediately.

**On startup** (`blockConcurrencyWhile`), the constructor creates tables, loads counters, cooldowns, catalog, OpenRouter list and router keys, resolves the account ID, imports the encryption key and decrypts stored provider keys into memory.

## Provider keys

`keysFor(provider)` = keys from the Wrangler secret named by `keyEnv` (comma/newline separated), then dashboard-added keys. Keyless providers (Kilo) get one empty slot. Key slot index `k` is stable within that order.

**Encryption** (`src/keystore.ts`):
- **Master key**: `KEYSTORE_SECRET` if set (64 hex chars used raw, otherwise SHA-256 of a 16+ character string). Without it, a random key is generated once and kept in `kv.keystore_key`.
- **Trade-off**: the generated key sits in the same storage as the ciphertext, so it keeps keys out of APIs and logs but not away from someone with storage access.
- **What the API reveals**: `listKeys()` never returns key values, only labels and last 4 characters. Changing the master key makes stored keys unreadable (`unreadableKeys` is reported).
- **Adding a key** clears that provider's cooldowns.

## Authentication and first-run setup

- **No secrets are required at deploy.** `GET /api/setup` reports `{claimed, locked, managedBySecret}`.
  - `claimed` is true when `PROXY_API_KEY` is set or any router key exists.
  - `locked` is true when unclaimed for 24 h after `first_seen`.
- **Claiming:** `POST /api/setup` creates the first `fgr_<64 hex>` key while unclaimed and unlocked. Only its SHA-256 hash and a 10-character prefix are stored.
- **More keys:** `/admin/router-keys` creates and revokes keys; the last key can't be revoked unless a `PROXY_API_KEY` secret exists. Revocation clears the auth cache in the handling isolate; other isolates catch up within 60 s.
- **`ADMIN_API_KEY`**, if set, becomes the only key accepted on `/admin/*`.
- **Self-hosted landing page:** it checks `/api/setup` on its own origin and sends an unclaimed install to `/dashboard` (Cloudflare's post-deploy "Visit" link opens `/`).

## Catalog

`DEFAULT_CATALOG` in `src/catalog.ts`. Provider fields:

| Field | Meaning |
|---|---|
| `id`, `name`, `keyEnv`, `signupUrl`, `notes` | Identity, key secret name, where to get a key, dashboard notes |
| `gateway` | `{mode:"compat", slug}` or `{mode:"path", path}` for AI Gateway; omit to call `directUrl` |
| `directUrl`, `modelsUrl`, `headers`, `timeoutMs` | Upstream details (`{ACCOUNT_ID}` is substituted) |
| `resetTz`, `limits` | Reset time zone, provider-level limits |
| `modelIdPattern`, `allowUnlisted` | $0 guard regex; whether explicit unlisted model ids are allowed |
| `keyless`, `requiresCard`, `streamUsage`, `disabled` | Behaviour flags |
| `models[]` | `{id, tags, priority, context, price, limits, disabled}` |

- **Runtime override without redeploying:** `GET /admin/catalog` → edit → `PUT /admin/catalog` (validated by `validateCatalog()`), or `DELETE` to go back to the default.
- **OpenRouter:** its `:free` models are merged in from a daily sync (`syncOpenRouter()`); catalog entries win.
- **Model staleness:** `GET /admin/probe` compares each provider's `/models` list with the catalog.

## Public endpoints (no auth)

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /api/setup`, `POST /api/setup` | First-run status and claim |
| `POST /api/waitlist` | Join or leave (`action: "remove"`) the hosted-beta waitlist |
| `POST /api/event` | Anonymous click count; allow-listed names only |
| `GET /api/stats` | Star count for the landing page; refreshes GitHub data when older than an hour |

**Waitlist protection:**
- A hidden honeypot field (bots that fill it get a fake success).
- Email validation.
- 5 requests per client per hour.
- The same reply whether or not an email was listed.

**Client ids** are a truncated SHA-256 of IP + daily salt (a secret, or a per-isolate random value), held in memory only.

## Scheduled work

The cron `17 3 * * *` runs `Tracker.maintenance()`:
- Flush pending writes.
- Prune stats older than 90 days and expired cooldowns.
- Sync OpenRouter's free models.
- When `GITHUB_REPO` is set, save GitHub stars, watchers, forks, 14-day views/clones, referrers and poll votes (traffic and poll need `GITHUB_TOKEN`).

## Cost model (Cloudflare side)

- **Per chat request:** about 1 Worker request + 2 Durable Object requests (acquire, settle), plus more on retries.
- **Durable Object duration is small:** the Durable Object isn't called while the upstream request is in flight.
- **Free plan:** 100k Worker and 100k Durable Object requests/day. The global cap of 30,000 requests/day (27,000 after the margin) keeps both inside it. Past a limit, the Free plan fails requests instead of billing.
- **Workers AI** usage is capped at its free daily neurons through USD metering.
- **Static assets** are free and unlimited.

## Gotchas learned the hard way

- **Deploy rollout:** right after `wrangler deploy`, some requests still hit the previous version for a few seconds. Poll for a new route or marker before testing.
- **Workers global scope:** Workers forbid `crypto.randomUUID()` and other random or async work at module scope. Create such values lazily.
- **Admin JSON is pretty-printed:** grep for keys, not compact `"k":v` pairs.
- **Deploy to Cloudflare button:**
  - Secrets come from `.dev.vars.example`, and `package.json` descriptions didn't reliably show for them. Forager avoids required secrets entirely.
  - The button copies the repo (not a fork) and needs the Cloudflare GitHub App.
  - Deploying with an existing Worker name replaces that Worker.
- **Free tiers drift constantly.** Catalog entries record the date each provider was checked, and the provider notes say why some are disabled.
