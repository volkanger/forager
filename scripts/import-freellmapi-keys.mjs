#!/usr/bin/env node
/**
 * Copies provider API keys from a local FreeLLMAPI install into this Worker's secrets.
 *
 * Keys are decrypted in memory (AES-256-GCM, FreeLLMAPI's format) and piped straight
 * into `wrangler secret bulk` over stdin. Nothing is written to disk and key values
 * are never printed.
 *
 *   node scripts/import-freellmapi-keys.mjs            # dry run: shows what would be imported
 *   node scripts/import-freellmapi-keys.mjs --apply    # uploads the secrets
 *
 * Options: --from <path to freellmapi>  (default: ../freellmapi)
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// FreeLLMAPI platform id → secret name used by this Worker's catalog.
const PLATFORM_TO_SECRET = {
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cohere: "COHERE_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  llm7: "LLM7_API_KEY",
  ollama: "OLLAMA_API_KEY",
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fromIdx = args.indexOf("--from");
const root = path.resolve(fromIdx >= 0 ? args[fromIdx + 1] : path.join(import.meta.dirname, "..", "..", "freellmapi"));
const dbPath = path.join(root, "server", "data", "freeapi.db");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function encryptionKey() {
  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, "utf8").match(/^ENCRYPTION_KEY=(.*)$/m);
    const value = match?.[1].trim().replace(/^["']|["']$/g, "");
    if (value && value !== "your-64-char-hex-key-here") return value;
  }
  const keyFile = path.join(root, "server", "data", ".encryption-key");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  fail(`No ENCRYPTION_KEY in ${envFile} and no ${keyFile}`);
}

if (!fs.existsSync(dbPath)) fail(`FreeLLMAPI database not found at ${dbPath} (use --from)`);
const hexKey = encryptionKey();
if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) fail("ENCRYPTION_KEY must be 64 hex characters");
const key = Buffer.from(hexKey, "hex");

const rows = JSON.parse(
  execFileSync("sqlite3", ["-readonly", "-json", dbPath, "SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled = 1 ORDER BY platform, id"], {
    encoding: "utf8",
  }) || "[]",
);

const secrets = {};
const report = [];
const skipped = new Set();
for (const row of rows) {
  const secretName = PLATFORM_TO_SECRET[row.platform];
  if (!secretName) {
    skipped.add(row.platform);
    continue;
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "hex"), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(row.auth_tag, "hex"));
    const value = (decipher.update(row.encrypted_key, "hex", "utf8") + decipher.final("utf8")).trim();
    if (!value) throw new Error("empty");
    secrets[secretName] = secrets[secretName] ? `${secrets[secretName]},${value}` : value;
    report.push(`  ✓ ${row.platform.padEnd(11)} → ${secretName} (key #${row.id}, ${value.length} chars)`);
  } catch (e) {
    report.push(`  ✗ ${row.platform.padEnd(11)} key #${row.id} could not be decrypted (${e.message})`);
  }
}

console.log(`FreeLLMAPI: ${root}`);
console.log(report.join("\n") || "  (no enabled keys for supported providers)");
if (skipped.size) console.log(`  – not supported by this Worker yet: ${[...skipped].join(", ")}`);

const count = Object.keys(secrets).length;
if (count === 0) fail("Nothing to import");
if (!apply) {
  console.log(`\nDry run. Re-run with --apply to upload ${count} secret(s) to the Worker.`);
  process.exit(0);
}

const child = spawn("npx", ["wrangler", "secret", "bulk"], { cwd: path.join(import.meta.dirname, ".."), stdio: ["pipe", "inherit", "inherit"] });
child.stdin.end(JSON.stringify(secrets));
child.on("exit", (code) => process.exit(code ?? 1));
