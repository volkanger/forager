/**
 * AES-256-GCM sealing for provider API keys added through the dashboard.
 *
 * The master key comes from the KEYSTORE_SECRET secret (64 hex chars, or any string of 16+ characters). Only ciphertext
 * is written to Durable Object storage; plaintext keys exist only in memory. Rotating
 * KEYSTORE_SECRET makes previously stored keys unreadable, so re-add them afterwards.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 64 hex chars are used as the raw key; any other string of 16+ characters is hashed with SHA-256. */
export async function importMasterKey(secret: string | undefined): Promise<CryptoKey | null> {
  const value = secret?.trim() ?? "";
  let raw: Uint8Array;
  if (/^[0-9a-fA-F]{64}$/.test(value)) raw = fromHex(value);
  else if (value.length >= 16) raw = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  else return null;
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 32 random bytes as hex: used when no KEYSTORE_SECRET is set, and for generated API keys. */
export function randomHex(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function seal(master: CryptoKey, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, master, encoder.encode(plaintext));
  return { ciphertext: toHex(new Uint8Array(sealed)), iv: toHex(iv) };
}

export async function unseal(master: CryptoKey, ciphertext: string, iv: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(iv) }, master, fromHex(ciphertext));
  return decoder.decode(plain);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
