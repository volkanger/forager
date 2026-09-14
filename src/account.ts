import type { Env } from "./env";

export interface CloudflareAccount {
  accountId: string | null;
  /** https://gateway.ai.cloudflare.com/v1/<account>/<gateway>, or null when no gateway is configured. */
  gatewayBase: string | null;
}

let cached: CloudflareAccount | undefined;

/**
 * Resolves the account ID without hardcoding it in the config, so a "Deploy to Cloudflare"
 * copy works on any account: CF_ACCOUNT_ID wins if set, otherwise it's read from the URL the
 * Workers AI binding reports for the gateway. Successful lookups are cached per isolate.
 */
export async function cloudflareAccount(env: Env): Promise<CloudflareAccount> {
  if (cached) return cached;
  const gatewayId = env.AI_GATEWAY_ID?.trim() || null;
  let accountId = env.CF_ACCOUNT_ID?.trim() || null;
  if (!accountId) {
    try {
      const url = await env.AI.gateway(gatewayId ?? "default").getUrl();
      accountId = url.match(/\/v1\/([0-9a-f]{32})\//i)?.[1] ?? null;
    } catch (e) {
      console.error("could not read the account ID from the AI binding", e);
    }
    if (!accountId) return { accountId: null, gatewayBase: null };
  }
  cached = { accountId, gatewayBase: gatewayId ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}` : null };
  return cached;
}
