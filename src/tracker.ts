import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_CATALOG,
  costUsd,
  splitKeys,
  validateCatalog,
  type Catalog,
  type GatewayRoute,
  type Limit,
  type ModelDef,
  type ProviderDef,
  type Window,
} from "./catalog";
import { nextReset, periodId } from "./cycles";
import type { Env } from "./env";
import { importMasterKey, seal, unseal } from "./keystore";
import { cloudflareAccount } from "./account";

type Usage = { p: string; req: number; tok: number; usd: number };
type Counter = Partial<Record<Window, Usage>>;

export interface ScopeRef {
  /** "g" (whole Worker), "p:<provider>#<key>" or "m:<provider>/<model>#<key>". */
  id: string;
  tz: string;
  limits: Limit[];
  /** Fraction of each limit that may be used; defaults to the catalog's safetyMargin. */
  margin?: number;
}

export interface Needs {
  tools: boolean;
  vision: boolean;
}

export interface AcquireInput {
  model: string;
  needs: Needs;
  estIn: number;
  estOut: number;
  /** Route ids ("p/m#k") or whole models ("p/m") already tried for this request. */
  exclude: string[];
}

export interface Route {
  routeId: string;
  provider: string;
  model: string;
  keyIndex: number;
  keyEnv: string;
  /** Plaintext provider key for this attempt ("" for keyless). Internal: never returned to clients. */
  key: string;
  gateway?: GatewayRoute;
  directUrl: string;
  headers?: Record<string, string>;
  streamUsage: boolean;
  timeoutMs?: number;
  price?: ModelDef["price"];
  estIn: number;
  estOut: number;
  estUsd: number;
  scopes: ScopeRef[];
}

export type AcquireResult =
  | { route: Route }
  | { error: string; status: number; retryAfter?: number; blocked?: Record<string, number> };

export interface SettleInput {
  route: Route;
  ok: boolean;
  status: number;
  inTok?: number;
  outTok?: number;
  latencyMs: number;
  cooldownMs?: number;
  /** key = every model on this key, route = this model on this key, model = this model on every key. */
  cooldownScope?: "key" | "route" | "model";
  reason?: string;
}

interface StatDelta {
  day: string;
  provider: string;
  model: string;
  requests: number;
  ok: number;
  tokIn: number;
  tokOut: number;
  usd: number;
  latencyMs: number;
}

interface StoredKey {
  id: string;
  provider: string;
  label: string;
  last4: string;
  createdAt: number;
  value: string;
}

interface Candidate {
  p: ProviderDef;
  m: ModelDef;
}

const FLUSH_DELAY_MS = 2_000;

/**
 * Single global Durable Object: the source of truth for quota counters, cooldowns,
 * routing decisions and usage stats. All state lives in memory and is flushed to
 * SQLite in small batches to stay well inside the free "rows written" allowance.
 */
export class Tracker extends DurableObject<Env> {
  private sql: SqlStorage;
  private catalog: Catalog = DEFAULT_CATALOG;
  private openRouterFree: ModelDef[] = [];
  private counters = new Map<string, Counter>();
  private cooldowns = new Map<string, { until: number; reason: string }>();
  private dirty = new Set<string>();
  private pendingStats = new Map<string, StatDelta>();
  private roundRobin = new Map<string, number>();
  private flushScheduled = false;
  private master: CryptoKey | null = null;
  private storedKeys: StoredKey[] = [];
  private unreadableKeys = 0;
  private accountId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS cooldowns (id TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL) WITHOUT ROWID`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS stats (
        day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
        tok_in INTEGER NOT NULL DEFAULT 0, tok_out INTEGER NOT NULL DEFAULT 0,
        usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider, model)) WITHOUT ROWID`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS provider_keys (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, last4 TEXT NOT NULL,
        ciphertext TEXT NOT NULL, iv TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID`);

      for (const row of this.sql.exec<{ id: string; data: string }>(`SELECT id, data FROM counters`)) {
        this.counters.set(row.id, JSON.parse(row.data));
      }
      const now = Date.now();
      for (const row of this.sql.exec<{ id: string; until: number; reason: string }>(`SELECT id, until, reason FROM cooldowns`)) {
        if (row.until > now) this.cooldowns.set(row.id, { until: row.until, reason: row.reason });
      }
      const catalog = this.kvGet("catalog");
      if (catalog) this.catalog = JSON.parse(catalog);
      const free = this.kvGet("openrouter_free");
      if (free) this.openRouterFree = JSON.parse(free);

      this.accountId = (await cloudflareAccount(this.env)).accountId;
      this.master = await importMasterKey(this.env.KEYSTORE_SECRET);
      const rows = this.sql
        .exec<{ id: string; provider: string; label: string; last4: string; ciphertext: string; iv: string; created_at: number }>(
          `SELECT id, provider, label, last4, ciphertext, iv, created_at FROM provider_keys ORDER BY created_at`,
        )
        .toArray();
      for (const row of rows) {
        try {
          if (!this.master) throw new Error("KEYSTORE_SECRET missing");
          const value = await unseal(this.master, row.ciphertext, row.iv);
          this.storedKeys.push({ id: row.id, provider: row.provider, label: row.label, last4: row.last4, createdAt: row.created_at, value });
        } catch {
          this.unreadableKeys++;
        }
      }
    });
  }

  // ---------------------------------------------------------------- routing

  acquire(input: AcquireInput): AcquireResult {
    const now = Date.now();
    const resolved = this.resolve(input);
    if ("error" in resolved) return resolved;

    const global: ScopeRef = { id: "g", tz: "UTC", limits: this.catalog.globalLimits };
    const globalHit = this.check(global, 1, 0, 0, now);
    if (globalHit) {
      return {
        error: `Worker-wide ${globalHit.window} cap reached; protecting the Cloudflare free plan.`,
        status: 429,
        retryAfter: Math.ceil((nextReset(globalHit.window, now) - now) / 1000),
      };
    }

    const blocked: Record<string, number> = {};
    const note = (reason: string) => (blocked[reason] = (blocked[reason] ?? 0) + 1);
    let soonest = Infinity;
    const estTok = input.estIn + input.estOut;

    for (const { p, m } of resolved.candidates) {
      const keys = this.keysFor(p);
      const keyCount = keys.length;
      const margin = this.marginFor(p);
      const tz = p.resetTz ?? "UTC";
      const estUsd = costUsd(m.price, input.estIn, input.estOut);
      const start = this.roundRobin.get(p.id) ?? 0;

      for (let i = 0; i < keyCount; i++) {
        const k = (start + i) % keyCount;
        const modelRef = `${p.id}/${m.id}`;
        const routeId = `${modelRef}#${k}`;
        if (input.exclude.includes(routeId) || input.exclude.includes(modelRef)) continue;

        const cooldown = this.activeCooldown([`c:${p.id}#${k}`, `c:${routeId}`, `c:${modelRef}`], now);
        if (cooldown) {
          note(`${modelRef}: cooling down (${cooldown.reason})`);
          soonest = Math.min(soonest, cooldown.until);
          continue;
        }

        const scopes: ScopeRef[] = [global];
        if (p.limits?.length) scopes.push({ id: `p:${p.id}#${k}`, tz, limits: p.limits, margin });
        if (m.limits?.length) scopes.push({ id: `m:${routeId}`, tz, limits: m.limits, margin });

        let hit: { window: Window; metric: string; scope: ScopeRef } | undefined;
        for (const scope of scopes) {
          const h = this.check(scope, 1, estTok, estUsd, now);
          if (h) {
            hit = { ...h, scope };
            break;
          }
        }
        if (hit) {
          const owner = hit.scope.id.startsWith("m:") ? modelRef : p.id;
          note(`${owner}: ${hit.window} ${hit.metric} quota used`);
          soonest = Math.min(soonest, nextReset(hit.window, now, hit.scope.tz));
          continue;
        }

        // Reserve with estimates now; settle() corrects to actual usage.
        for (const scope of scopes) this.bump(scope, now, 1, estTok, estUsd);
        this.roundRobin.set(p.id, k + 1);
        this.scheduleFlush();

        return {
          route: {
            routeId,
            provider: p.id,
            model: m.id,
            keyIndex: k,
            keyEnv: p.keyEnv,
            key: keys[k],
            gateway: p.gateway,
            directUrl: p.directUrl,
            headers: p.headers,
            streamUsage: !!p.streamUsage,
            timeoutMs: p.timeoutMs,
            price: m.price,
            estIn: input.estIn,
            estOut: input.estOut,
            estUsd,
            scopes,
          },
        };
      }
    }

    const tried = input.exclude.length > 0;
    return {
      error: tried
        ? "Every remaining candidate failed or is out of free quota."
        : "All candidate models are rate-limited, cooling down, or out of free quota for this cycle.",
      status: 429,
      retryAfter: Number.isFinite(soonest) ? Math.max(1, Math.ceil((soonest - now) / 1000)) : 60,
      blocked,
    };
  }

  settle(s: SettleInput): void {
    const now = Date.now();
    const r = s.route;
    const inTok = s.ok ? (s.inTok ?? r.estIn) : 0;
    const outTok = s.ok ? (s.outTok ?? r.estOut) : 0;
    const usd = costUsd(r.price, inTok, outTok);

    // Request stays counted even on failure (providers count them too); tokens/spend are corrected.
    for (const scope of r.scopes) this.bump(scope, now, 0, inTok + outTok - (r.estIn + r.estOut), usd - r.estUsd);

    if (s.cooldownMs && s.cooldownMs > 0) {
      const id =
        s.cooldownScope === "key"
          ? `c:${r.provider}#${r.keyIndex}`
          : s.cooldownScope === "model"
            ? `c:${r.provider}/${r.model}`
            : `c:${r.routeId}`;
      const until = now + s.cooldownMs;
      const reason = s.reason ?? `HTTP ${s.status}`;
      const existing = this.cooldowns.get(id);
      if (!existing || existing.until < until) {
        this.cooldowns.set(id, { until, reason });
        this.sql.exec(
          `INSERT INTO cooldowns (id, until, reason) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET until = excluded.until, reason = excluded.reason`,
          id,
          until,
          reason,
        );
      }
    }

    const day = periodId("day", now, "UTC");
    const key = `${day}|${r.provider}|${r.model}`;
    const st = this.pendingStats.get(key) ?? { day, provider: r.provider, model: r.model, requests: 0, ok: 0, tokIn: 0, tokOut: 0, usd: 0, latencyMs: 0 };
    st.requests += 1;
    st.ok += s.ok ? 1 : 0;
    st.tokIn += inTok;
    st.tokOut += outTok;
    st.usd += usd;
    st.latencyMs += Math.round(s.latencyMs);
    this.pendingStats.set(key, st);
    this.scheduleFlush();
  }

  listModels(): { id: string; owned_by: string; tags: string[] }[] {
    const out: { id: string; owned_by: string; tags: string[] }[] = [{ id: "auto", owned_by: "forager", tags: [] }];
    const providers = this.providers().filter((p) => !this.unusableReason(p));
    const tags = new Set<string>();
    for (const p of providers) for (const m of p.models) for (const t of m.tags ?? []) tags.add(t);
    for (const t of [...tags].sort()) out.push({ id: `auto:${t}`, owned_by: "forager", tags: [t] });
    for (const name of Object.keys(this.catalog.profiles ?? {})) out.push({ id: `auto:${name}`, owned_by: "forager", tags: [] });
    for (const p of providers) {
      for (const m of p.models) if (this.allowed(p, m)) out.push({ id: `${p.id}/${m.id}`, owned_by: p.id, tags: m.tags ?? [] });
    }
    return out;
  }

  // ---------------------------------------------------------------- admin

  usage() {
    this.flush();
    const now = Date.now();
    const view = (scope: ScopeRef, key: number | null) =>
      scope.limits.flatMap((l) =>
        (["requests", "tokens", "usd"] as const)
          .filter((metric) => l[metric] !== undefined)
          .map((metric) => {
            const used = this.used(scope.id, l.window, scope.tz, now);
            const limit = l[metric]!;
            return {
              key,
              window: l.window,
              metric,
              used: metric === "requests" ? used.req : metric === "tokens" ? used.tok : Math.round(used.usd * 1e6) / 1e6,
              limit,
              cap: this.cap(limit, metric, scope.margin),
              resetsAt: nextReset(l.window, now, scope.tz),
            };
          }),
      );

    const providers = this.providers().map((p) => {
      const keys = this.keysFor(p).length;
      const tz = p.resetTz ?? "UTC";
      const margin = this.marginFor(p);
      const keyIdx = [...Array(keys).keys()];
      return {
        id: p.id,
        name: p.name,
        notes: p.notes,
        keyEnv: p.keyEnv,
        keys,
        requiresCard: !!p.requiresCard,
        signupUrl: p.signupUrl,
        viaGateway: !!(p.gateway && this.accountId && this.env.AI_GATEWAY_ID),
        unusable: this.unusableReason(p),
        resetTz: tz,
        limits: keyIdx.flatMap((k) => view({ id: `p:${p.id}#${k}`, tz, limits: p.limits ?? [], margin }, k)),
        models: p.models
          .filter((m) => this.allowed(p, m))
          .map((m) => ({
            id: m.id,
            tags: m.tags ?? [],
            priority: m.priority ?? 0,
            limits: keyIdx.flatMap((k) => view({ id: `m:${p.id}/${m.id}#${k}`, tz, limits: m.limits ?? [], margin }, k)),
          })),
      };
    });

    const cooldowns = [...this.cooldowns.entries()]
      .filter(([, c]) => c.until > now)
      .map(([id, c]) => ({ target: id.slice(2), until: c.until, reason: c.reason }));

    const today = periodId("day", now, "UTC");
    const weekAgo = periodId("day", now - 6 * 86_400_000, "UTC");
    const rows = (sql: string, ...args: SqlStorageValue[]) => this.sql.exec(sql, ...args).toArray();

    return {
      now,
      catalogVersion: this.catalog.version,
      customCatalog: !!this.kvGet("catalog"),
      safetyMargin: this.catalog.safetyMargin,
      gateway: { accountId: !!this.accountId, gatewayId: this.env.AI_GATEWAY_ID ?? null },
      global: view({ id: "g", tz: "UTC", limits: this.catalog.globalLimits }, null),
      providers,
      cooldowns,
      today: rows(
        `SELECT provider, model, requests, ok, tok_in, tok_out, usd, latency_ms FROM stats WHERE day = ? ORDER BY requests DESC`,
        today,
      ),
      week: rows(
        `SELECT day, SUM(requests) AS requests, SUM(ok) AS ok, SUM(tok_in) AS tok_in, SUM(tok_out) AS tok_out, SUM(usd) AS usd
         FROM stats WHERE day >= ? GROUP BY day ORDER BY day`,
        weekAgo,
      ),
    };
  }

  getCatalog(): { catalog: Catalog; custom: boolean; openRouterFree: number } {
    return { catalog: this.catalog, custom: !!this.kvGet("catalog"), openRouterFree: this.openRouterFree.length };
  }

  setCatalog(input: unknown): { ok: true; version: string } {
    const catalog = validateCatalog(input);
    this.catalog = catalog;
    this.kvSet("catalog", JSON.stringify(catalog));
    return { ok: true, version: catalog.version };
  }

  resetCatalog(): { ok: true; version: string } {
    this.sql.exec(`DELETE FROM kv WHERE k = 'catalog'`);
    this.catalog = DEFAULT_CATALOG;
    return { ok: true, version: DEFAULT_CATALOG.version };
  }

  /** Clears counters and cooldowns whose id contains `match` (all when omitted). */
  resetCounters(match?: string): { cleared: number } {
    let cleared = 0;
    for (const map of [this.counters, this.cooldowns] as Map<string, unknown>[]) {
      for (const id of [...map.keys()]) {
        if (!match || id.includes(match)) {
          map.delete(id);
          this.dirty.delete(id);
          cleared++;
        }
      }
    }
    if (match) {
      const like = `%${match.replace(/[%_]/g, "")}%`;
      this.sql.exec(`DELETE FROM counters WHERE id LIKE ?`, like);
      this.sql.exec(`DELETE FROM cooldowns WHERE id LIKE ?`, like);
    } else {
      this.sql.exec(`DELETE FROM counters`);
      this.sql.exec(`DELETE FROM cooldowns`);
    }
    return { cleared };
  }

  /** Pulls OpenRouter's current ":free" models (public endpoint, no key needed). */
  async syncOpenRouter(): Promise<{ count: number }> {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`OpenRouter model list returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      data: { id: string; context_length?: number; supported_parameters?: string[]; architecture?: { input_modalities?: string[] } }[];
    };
    const models: ModelDef[] = body.data
      .filter((m) => m.id.endsWith(":free"))
      .map((m) => ({
        id: m.id,
        context: m.context_length,
        priority: 40,
        tags: [
          ...(m.supported_parameters?.includes("tools") ? ["tools"] : []),
          ...(m.architecture?.input_modalities?.includes("image") ? ["vision"] : []),
        ],
      }));
    this.openRouterFree = models;
    this.kvSet("openrouter_free", JSON.stringify(models));
    return { count: models.length };
  }

  // ---------------------------------------------------------------- provider keys

  /** Key inventory for the dashboard. Never includes key values. */
  listKeys() {
    return {
      keystoreReady: !!this.master,
      unreadableKeys: this.unreadableKeys,
      providers: this.providers().map((p) => ({
        id: p.id,
        name: p.name,
        keyEnv: p.keyEnv,
        keyless: !!p.keyless,
        requiresCard: !!p.requiresCard,
        signupUrl: p.signupUrl,
        notes: p.notes,
        secretKeys: splitKeys(this.env[p.keyEnv]).length,
        stored: this.storedKeys
          .filter((k) => k.provider === p.id)
          .map(({ id, label, last4, createdAt }) => ({ id, label, last4, createdAt })),
        testModel: p.models
          .filter((m) => this.allowed(p, m))
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]?.id,
      })),
    };
  }

  async addKey(input: { provider?: string; key?: string; label?: string }): Promise<{ id: string; last4: string }> {
    if (!this.master) throw new Error("Key storage is not set up: the KEYSTORE_SECRET secret is missing or invalid.");
    const provider = this.catalog.providers.find((p) => p.id === input.provider);
    if (!provider) throw new Error(`Unknown provider "${input.provider}".`);
    const value = (input.key ?? "").trim();
    if (value.length < 8 || value.length > 1000 || /\s/.test(value)) throw new Error("That doesn't look like an API key.");
    if ([...splitKeys(this.env[provider.keyEnv]), ...this.storedKeys.filter((k) => k.provider === provider.id).map((k) => k.value)].includes(value)) {
      throw new Error(`This key is already configured for ${provider.name}.`);
    }
    const label = (input.label ?? "").trim().slice(0, 60) || `Key added ${new Date().toISOString().slice(0, 10)}`;
    const { ciphertext, iv } = await seal(this.master, value);
    const key: StoredKey = { id: crypto.randomUUID(), provider: provider.id, label, last4: value.slice(-4), createdAt: Date.now(), value };
    this.sql.exec(
      `INSERT INTO provider_keys (id, provider, label, last4, ciphertext, iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      key.id,
      key.provider,
      key.label,
      key.last4,
      ciphertext,
      iv,
      key.createdAt,
    );
    this.storedKeys.push(key);
    // A fresh key deserves a fresh start: clear old pauses on this provider's key slots.
    this.resetCounters(`c:${provider.id}`);
    return { id: key.id, last4: key.last4 };
  }

  deleteKey(id: string): { deleted: boolean } {
    const before = this.storedKeys.length;
    this.storedKeys = this.storedKeys.filter((k) => k.id !== id);
    this.sql.exec(`DELETE FROM provider_keys WHERE id = ?`, id);
    return { deleted: this.storedKeys.length < before };
  }

  /** Compares each provider's model list with the catalog, using its first configured key. */
  async probe() {
    const results = await Promise.all(
      this.providers()
        .filter((p) => p.modelsUrl)
        .map(async (p) => {
          const keys = this.keysFor(p);
          if (keys.length === 0) return { provider: p.id, skipped: "no API key" };
          try {
            const res = await fetch(p.modelsUrl!.replace("{ACCOUNT_ID}", this.accountId ?? ""), {
              headers: { ...p.headers, ...(keys[0] ? { authorization: `Bearer ${keys[0]}` } : {}) },
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) return { provider: p.id, status: res.status, error: (await res.text()).slice(0, 200) };
            const data = (await res.json()) as { data?: { id: string }[]; result?: { name: string }[]; models?: { name: string }[] };
            const upstream = new Set(
              [...(data.data ?? []).map((m) => m.id), ...(data.result ?? []).map((m) => m.name), ...(data.models ?? []).map((m) => m.name)].map(
                (id) => id.replace(/^models\//, ""),
              ),
            );
            const listed = p.models.map((m) => m.id);
            return {
              provider: p.id,
              status: res.status,
              upstreamModels: upstream.size,
              missingUpstream: listed.filter((id) => !upstream.has(id)),
              notInCatalog: [...upstream].filter((id) => !listed.includes(id)).slice(0, 50),
            };
          } catch (e) {
            return { provider: p.id, error: e instanceof Error ? e.message : String(e) };
          }
        }),
    );
    return { note: "missingUpstream = catalog entries the provider no longer lists; update them via PUT /admin/catalog.", results };
  }

  /** Daily maintenance from the cron trigger. */
  async maintenance(): Promise<void> {
    this.flush();
    const cutoff = periodId("day", Date.now() - 90 * 86_400_000, "UTC");
    this.sql.exec(`DELETE FROM stats WHERE day < ?`, cutoff);
    this.sql.exec(`DELETE FROM cooldowns WHERE until < ?`, Date.now());
    await this.syncOpenRouter().catch((e) => console.error("openrouter sync failed", e));
  }

  async alarm(): Promise<void> {
    this.flushScheduled = false;
    this.flush();
  }

  // ---------------------------------------------------------------- internals

  /** Catalog providers, with OpenRouter's synced free list merged in (catalog entries win). */
  private providers(): ProviderDef[] {
    return this.catalog.providers
      .filter((p) => !p.disabled)
      .map((p) => {
        if (p.id !== "openrouter" || this.openRouterFree.length === 0) return p;
        const known = new Set(p.models.map((m) => m.id));
        return { ...p, models: [...p.models, ...this.openRouterFree.filter((m) => !known.has(m.id))] };
      });
  }

  /** Keys from the Wrangler secret first, then keys added in the dashboard. Keyless providers get one empty slot. */
  private keysFor(p: ProviderDef): string[] {
    const keys = [...splitKeys(this.env[p.keyEnv]), ...this.storedKeys.filter((k) => k.provider === p.id).map((k) => k.value)];
    return keys.length === 0 && p.keyless ? [""] : keys;
  }

  /** Card-unlocked providers keep extra headroom. */
  private marginFor(p: ProviderDef): number {
    return p.requiresCard ? Math.min(this.catalog.safetyMargin, 0.8) : this.catalog.safetyMargin;
  }

  private unusableReason(p: ProviderDef): string | null {
    if (this.keysFor(p).length === 0) return "no API key yet";
    if (p.directUrl.includes("{ACCOUNT_ID}") && !this.accountId) return "Cloudflare account ID unavailable (add the AI binding or set CF_ACCOUNT_ID)";
    return null;
  }

  private allowed(p: ProviderDef, m: ModelDef): boolean {
    if (m.disabled) return false;
    return !p.modelIdPattern || new RegExp(p.modelIdPattern).test(m.id);
  }

  private resolve(input: AcquireInput): { candidates: Candidate[] } | { error: string; status: number } {
    const want = (input.model || "auto").trim();
    const all = this.providers();
    const usable = all.filter((p) => !this.unusableReason(p));
    const byPriority = (a: Candidate, b: Candidate) => (b.m.priority ?? 0) - (a.m.priority ?? 0);

    if (want === "auto" || want.startsWith("auto:")) {
      const name = want.slice(5);
      const profile = name ? this.catalog.profiles?.[name] : undefined;
      let candidates: Candidate[];
      if (profile) {
        candidates = profile.flatMap((ref) => {
          const found = this.findExplicit(usable, ref);
          return found && this.allowed(found.p, found.m) ? [found] : [];
        });
      } else {
        candidates = usable
          .flatMap((p) => p.models.filter((m) => this.allowed(p, m)).map((m) => ({ p, m })))
          .filter(({ m }) => !name || m.tags?.includes(name))
          .sort(byPriority);
      }
      const est = input.estIn + input.estOut;
      const fitting = candidates.filter(
        ({ m }) =>
          (!input.needs.tools || m.tags?.includes("tools")) &&
          (!input.needs.vision || m.tags?.includes("vision")) &&
          (!m.context || m.context >= est),
      );
      if (fitting.length === 0) {
        const need = [input.needs.tools && "tools", input.needs.vision && "vision"].filter(Boolean).join(" + ");
        return {
          error: candidates.length
            ? `No configured model matching "${want}" supports this request${need ? ` (needs ${need})` : ""} or fits its size.`
            : `No configured model matches "${want}". Add provider keys or check the tag/profile name.`,
          status: 400,
        };
      }
      return { candidates: fitting };
    }

    const providerId = want.includes("/") ? want.slice(0, want.indexOf("/")) : "";
    const provider = all.find((p) => p.id === providerId);
    if (provider) {
      const reason = this.unusableReason(provider);
      if (reason) return { error: `Provider ${provider.id} is not configured: ${reason}.`, status: 400 };
      const found = this.findExplicit(usable, want);
      if (!found) return { error: `Model "${want}" is not in the catalog for ${provider.id}.`, status: 404 };
      if (!this.allowed(found.p, found.m)) {
        return { error: `Model "${want}" is blocked by the $0 guard (${provider.modelIdPattern ?? "disabled"}).`, status: 403 };
      }
      return { candidates: [found] };
    }

    // Bare model id: every provider that serves it.
    const candidates = usable
      .flatMap((p) => p.models.filter((m) => this.allowed(p, m) && (m.id === want || m.id.endsWith(`/${want}`))).map((m) => ({ p, m })))
      .sort(byPriority);
    if (candidates.length === 0) return { error: `Model "${want}" not found. GET /v1/models lists available ids.`, status: 404 };
    return { candidates };
  }

  private findExplicit(providers: ProviderDef[], ref: string): Candidate | null {
    const slash = ref.indexOf("/");
    if (slash < 0) return null;
    const p = providers.find((x) => x.id === ref.slice(0, slash));
    if (!p) return null;
    const id = ref.slice(slash + 1);
    const m = p.models.find((x) => x.id === id) ?? (p.allowUnlisted ? { id } : undefined);
    return m ? { p, m } : null;
  }

  private cap(limit: number, metric: "requests" | "tokens" | "usd", margin = this.catalog.safetyMargin): number {
    const c = limit * margin;
    return metric === "usd" ? c : Math.max(1, Math.floor(c));
  }

  private check(scope: ScopeRef, req: number, tok: number, usd: number, now: number): { window: Window; metric: string } | null {
    for (const l of scope.limits) {
      const u = this.used(scope.id, l.window, scope.tz, now);
      if (l.requests !== undefined && u.req + req > this.cap(l.requests, "requests", scope.margin)) return { window: l.window, metric: "request" };
      if (l.tokens !== undefined && u.tok + tok > this.cap(l.tokens, "tokens", scope.margin)) return { window: l.window, metric: "token" };
      if (l.usd !== undefined && u.usd + usd > this.cap(l.usd, "usd", scope.margin)) return { window: l.window, metric: "spend" };
    }
    return null;
  }

  private used(id: string, window: Window, tz: string, now: number): Usage {
    const p = periodId(window, now, tz);
    const u = this.counters.get(id)?.[window];
    return u && u.p === p ? u : { p, req: 0, tok: 0, usd: 0 };
  }

  private bump(scope: ScopeRef, now: number, req: number, tok: number, usd: number): void {
    const counter = this.counters.get(scope.id) ?? {};
    for (const window of new Set(scope.limits.map((l) => l.window))) {
      const u = this.used(scope.id, window, scope.tz, now);
      counter[window] = { p: u.p, req: Math.max(0, u.req + req), tok: Math.max(0, u.tok + tok), usd: Math.max(0, u.usd + usd) };
    }
    this.counters.set(scope.id, counter);
    this.dirty.add(scope.id);
  }

  private activeCooldown(ids: string[], now: number): { until: number; reason: string } | null {
    let best: { until: number; reason: string } | null = null;
    for (const id of ids) {
      const c = this.cooldowns.get(id);
      if (!c) continue;
      if (c.until <= now) {
        this.cooldowns.delete(id);
        continue;
      }
      if (!best || c.until > best.until) best = c;
    }
    return best;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY_MS).catch(() => {
      this.flushScheduled = false;
    });
  }

  private flush(): void {
    for (const id of this.dirty) {
      const counter = this.counters.get(id);
      if (!counter) continue;
      this.sql.exec(
        `INSERT INTO counters (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        id,
        JSON.stringify(counter),
      );
    }
    this.dirty.clear();
    for (const s of this.pendingStats.values()) {
      this.sql.exec(
        `INSERT INTO stats (day, provider, model, requests, ok, tok_in, tok_out, usd, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, provider, model) DO UPDATE SET
           requests = requests + excluded.requests, ok = ok + excluded.ok,
           tok_in = tok_in + excluded.tok_in, tok_out = tok_out + excluded.tok_out,
           usd = usd + excluded.usd, latency_ms = latency_ms + excluded.latency_ms`,
        s.day,
        s.provider,
        s.model,
        s.requests,
        s.ok,
        s.tokIn,
        s.tokOut,
        s.usd,
        s.latencyMs,
      );
    }
    this.pendingStats.clear();
  }

  private kvGet(k: string): string | null {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM kv WHERE k = ?`, k).toArray()[0];
    return row?.v ?? null;
  }

  private kvSet(k: string, v: string): void {
    this.sql.exec(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }
}
