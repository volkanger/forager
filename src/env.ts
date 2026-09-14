import type { Tracker } from "./tracker";

export interface Env {
  TRACKER: DurableObjectNamespace<Tracker>;
  /** Workers AI binding; used to discover the account ID for AI Gateway URLs. */
  AI: Ai;

  PROXY_API_KEY?: string;
  ADMIN_API_KEY?: string;

  /** 64 hex chars; encrypts provider keys added from the dashboard. */
  KEYSTORE_SECRET?: string;

  /** Optional: normally discovered through the AI binding. */
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
  GATEWAY_CACHE_TTL?: string;

  MAX_ATTEMPTS?: string;
  UPSTREAM_TIMEOUT_MS?: string;

  /** Provider key secrets are looked up by name from the catalog (GROQ_API_KEY, ...). */
  [secret: string]: unknown;
}
