# Forager

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/volkanger/forager)

**[fora.ger.soy](https://fora.ger.soy)**

Forager is an LLM router you host on your own Cloudflare account, inspired by the self-hosted
[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). It gives you one OpenAI-compatible
endpoint that spreads requests across the free tiers of many LLM providers (Groq, Gemini,
NVIDIA, Mistral, OpenRouter, Zhipu, Kilo, Ollama Cloud, Cohere, Workers AI and more). It tracks
how much of each provider's free quota you've used in every cycle, so it stops before a limit
instead of running up a bill. Everything runs on the Cloudflare Workers Free plan.

```
client ──► Worker /v1/chat/completions
             │  1. acquire(): Tracker Durable Object picks the best model + key
             │     that has room left in every cycle (minute / hour / day / month)
             ├─► AI Gateway ──► Groq · Gemini · Mistral · OpenRouter · Cohere · Workers AI
             ├─► direct       ──► NVIDIA · Zhipu · Kilo · LLM7 · Ollama · SambaNova · …
             │  2. on 429/5xx/timeout: cool down that model or key, try the next one
             └─ 3. settle(): record the real token usage from the response (streams included)
```

## Deploy in one click

1. Click **Deploy to Cloudflare** above, sign in, and pick a project name. Cloudflare copies this repo to your GitHub or GitLab account and creates the Worker and its Durable Object. There are no secrets to fill in.
2. Open `https://<project-name>.<your-subdomain>.workers.dev/dashboard` and click **Create my API key**. Save the key in your password manager: it's shown once. Your apps use it for `/v1`, and you use it to sign in to the dashboard.
3. In **Provider keys**, add a key for each free provider you use. Every provider has a "get a key" link, and a test request runs as soon as you add one. Kilo works with no key, so `auto` answers right away.

Open the dashboard soon after deploying: if nobody creates the first key within 24 hours of the Worker's first visit, setup locks, and you'd need `npx wrangler secret put PROXY_API_KEY` to take ownership.

**Optional, AI Gateway logging:** create a gateway named `forager` under **AI → AI Gateway** in the Cloudflare dashboard. If you turn on *Authenticated Gateway*, add a `CF_AIG_TOKEN` secret (a token with "AI Gateway: Run"). Until then, Forager calls providers directly.

Pushes to your copy of the repo redeploy automatically.

## Deploy from the command line

```bash
git clone https://github.com/volkanger/forager && cd forager
npm install
npx wrangler login
npx wrangler deploy
# then open /dashboard on the Worker URL and click "Create my API key"
```

To serve it on your own domain (the zone must be on your Cloudflare account): `npx wrangler deploy --domain llm.example.com`.

## Updating your copy

The Deploy button makes a **copy** of this repo in your account, not a fork, so new Forager releases don't reach it on their own. Your data is safe across updates: API keys, provider keys, quota counters and stats live in the Durable Object, not in the code.

**If you used the Deploy button** (Cloudflare redeploys whenever you push to your copy's main branch):

```bash
git clone https://github.com/<you>/<your-copy> && cd <your-copy>
git remote add upstream https://github.com/volkanger/forager
git fetch upstream
git checkout upstream/main -- .     # take the latest Forager files
git status                          # review what changed
git commit -m "Update Forager" && git push
```

The checkout replaces files you edited with the upstream version. To keep custom limits or providers through updates, change them at runtime with `PUT /admin/catalog` instead of editing `src/catalog.ts`; runtime changes live in the Durable Object. If you did edit files, check `git diff --staged` before committing and re-apply what you need.

**If you deployed from the command line:**

```bash
cd forager && git pull && npm install && npx wrangler deploy
```

To hear about new releases, click **Watch → Custom → Releases** on the [GitHub repo](https://github.com/volkanger/forager).

## What keeps it at $0

| Guard | How |
|---|---|
| Quota cycles | Per-key counters for requests, tokens and USD in minute/hour/day/month windows. Day and month cycles reset in each provider's own time zone (Gemini resets at midnight Pacific). |
| Safety margin | Routing to a key stops once 90% of any limit is used (`safetyMargin`). |
| Reservations | Before each call the router reserves estimated tokens (prompt + `max_tokens`, capped at 4096). It corrects to the real usage afterwards. |
| Metered allowances | Workers AI's 10,000 free neurons/day are tracked as $0.11/day, using the official per-token prices. |
| Paid-model block | OpenRouter only allows ids ending in `:free`, even when you ask for a paid model by name. |
| Billing errors | HTTP 402 from a provider disables that key for 24h. |
| Learned limits | If a provider's `x-ratelimit-remaining-*` header reaches 0, that key rests until the reset time in the header. |
| Cloudflare side | Worker-wide cap of 30k chat requests/day. That keeps the Worker and the Durable Object inside the Free plan's 100k requests/day and 100k rows written/day. Counters are written to storage in batches. |

**Limits of this design (please read):**
- Local counters can't see usage from outside this router, like the same key used in another app or a provider's console. Use a dedicated key for each provider.
- You still have to keep each provider account free: **no billing account on the Gemini Google Cloud project**, and no auto-top-up on OpenRouter. Cerebras is disabled: it no longer has a free tier.
- The default limits were checked in September 2026 but change often. Run `GET /admin/probe` and compare with each provider's console.
- Several free accounts for the same provider, just to stack quotas, usually break that provider's terms. The multiple-keys feature is meant for keys you're allowed to use.
- On the Workers **Free** plan, Cloudflare returns errors when you go over a limit and never bills you. On the **Paid** plan, the global cap and Workers AI budget are what protect you.

## Adding provider keys

**From the dashboard (easiest):** in **Provider keys**, pick a provider, paste its key and click **Add key**. Forager encrypts the key with AES-256-GCM, stores only the ciphertext, and runs a test request right away. The dashboard and API never show a key again, only its last 4 characters. Each provider has a "get a key" link. Providers without a key are skipped.

**Or as Wrangler secrets:** `npx wrangler secret put GROQ_API_KEY` and so on (each provider's `keyEnv` in `src/catalog.ts`). Comma-separate several keys you're allowed to use. Secret keys and dashboard keys are combined.

**From a local FreeLLMAPI install:** `node scripts/import-freellmapi-keys.mjs --apply`.

**Encryption key:** by default Forager generates one and keeps it in the same Durable Object. That keeps provider keys out of every API response and log, but anyone with access to the Durable Object's storage could decrypt them. For stronger separation, set a `KEYSTORE_SECRET` secret (16+ characters) before adding keys. Changing or adding it later makes existing dashboard keys unreadable; the dashboard flags them so you can re-add them.

**API keys for your apps:** create one per app under **Your API keys** in the dashboard and revoke any of them later (takes effect within a minute). A `PROXY_API_KEY` secret, if set, works alongside them.

`CF_API_TOKEN` (Workers AI) needs "Workers AI: Read" and "Edit". Providers marked **card on file** (Vercel) unlock their free tier only after you add a payment method; Forager keeps 20% headroom on them, and you're only charged if you buy credits there.

## Use it

```bash
curl https://forager.<your-subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $FORAGER_API_KEY" -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

Any OpenAI SDK works if you set `base_url` to `…/v1` and `api_key` to your Forager API key. Each response has an `x-routed-via: provider/model` header.

| `model` | Behaviour |
|---|---|
| `auto` | Highest-priority model that has quota left, with automatic fallback |
| `auto:<tag>` | Same, limited to a tag: `fast`, `smart`, `coding`, `tools`, `vision`, `reasoning` |
| `auto:<profile>` | A fallback chain you define in order (`auto:coding` comes built in) |
| `groq/openai/gpt-oss-120b` | Only that provider and model, rotating across its keys |
| `gpt-oss-120b` | Every provider that serves that model id |

Requests that use `tools` or image inputs only go to models tagged with those abilities, and only when the prompt fits the model's context window. Streaming is supported: the router asks the provider for usage data and reads it from the stream. Fallback to another model only happens before the first byte is sent.

## Admin API

Send any of your API keys as a bearer token (or only `ADMIN_API_KEY`, if you set that secret).

| Endpoint | Purpose |
|---|---|
| `GET /admin/usage` | Every limit per key: used, cap, reset time. Also cooldowns, today's and the last 7 days' stats |
| `GET /admin/catalog` | The catalog currently in use |
| `PUT /admin/catalog` | Replace the catalog at runtime, no redeploy (checked before saving) |
| `DELETE /admin/catalog` | Go back to the built-in catalog in `src/catalog.ts` |
| `POST /admin/sync` | Fetch OpenRouter's current `:free` models now (a cron job also runs this daily) |
| `GET /admin/probe` | Ask each provider for its model list and flag catalog entries that no longer exist |
| `POST /admin/reset` `{"match":"groq"}` | Clear counters and cooldowns (all of them if you leave out `match`) |
| `GET /admin/keys` | Providers with key counts, last 4 characters of stored keys, and "get a key" links |
| `POST /admin/keys` `{"provider","key","label"}` | Encrypt and store a provider key |
| `DELETE /admin/keys/<id>` | Remove a stored provider key |
| `GET /admin/router-keys` · `POST` `{"label"}` · `DELETE /admin/router-keys/<id>` | List, create and revoke your Forager API keys |
| `GET /api/setup` · `POST /api/setup` (no auth) | First-run status, and create the first API key while unclaimed |

To change limits, run `GET /admin/catalog`, edit the `catalog` object, and `PUT` it back. For example, after a one-time $10 OpenRouter credit purchase, raise `openrouter.limits` day requests from 50 to 1000.

## Roadmap: phase 2 (usage reconciliation with providers)

The MVP only knows what went through this router. Phase 2 syncs with each provider's real usage wherever that is exposed:

1. **Sync counters from headers.** After every response, set used = limit − remaining from `x-ratelimit-remaining-*` (Groq confirmed; Mistral per-minute, to verify).
2. **Hourly cron plus a check before a session.**
   - Workers AI: pull the account's real neuron count from the GraphQL Analytics API (`aiInferenceAdaptiveGroups`, needs Account Analytics Read) and overwrite the counter.
   - OpenRouter: check `GET /api/v1/key` → `usage_daily`. If it isn't $0, disable the key and flag it.
3. **Optional ping on demand.** Send a 1-token request to each header-based provider to read its remaining quota. Each ping costs one request of the daily quota.
4. **Dashboard badge.** Mark providers with no usage API (Gemini, Cohere, NVIDIA) as "keep this key dedicated".

## How it works inside

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walks through a request step by step: routing, quota cycles, the failure policy, the Durable Object data model, key encryption, first-run setup, scheduled jobs and the cost model.

## Files

- `src/index.ts`: HTTP routes, auth, the upstream call with failover, SSE usage tap
- `src/tracker.ts`: Durable Object with routing, cycle counters, cooldowns, stats and the runtime catalog
- `src/catalog.ts`: providers, models, free-tier limits, validation
- `src/cycles.ts`: cycle ids and reset times per time zone
- `src/keystore.ts`: AES-GCM encryption for dashboard-added keys
- `src/account.ts`: account ID discovery through the AI binding (no account-specific config)
- `src/dashboard.html`: dashboard and playground
