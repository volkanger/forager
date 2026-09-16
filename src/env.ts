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
  /** Provider ids whose prompt-cache hits are not billed against our token counters. */
  CACHED_TOKENS_FREE?: string;

  /** "owner/repo" whose GitHub stars/traffic are tracked for the interest dashboard (optional). */
  GITHUB_REPO?: string;
  /** Read-only GitHub token; needed for traffic (views/clones), optional for star counts. */
  GITHUB_TOKEN?: string;
  /** Discussion number of the GitHub poll to track (optional; needs GITHUB_TOKEN). */
  GITHUB_POLL?: string;

  /**
   * Set to "1" to let /chat save conversations in the Durable Object, scoped to the API key that
   * wrote them. Absent (the default, including every Deploy-button copy) means chats never leave
   * the browser.
   */
  CHAT_HISTORY?: string;

  MAX_ATTEMPTS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  UPSTREAM_STREAM_TIMEOUT_MS?: string;

  /** Provider key secrets are looked up by name from the catalog (GROQ_API_KEY, ...). */
  [secret: string]: unknown;
}
