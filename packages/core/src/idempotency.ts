/**
 * Canonicalizes request bodies and hashes them for idempotency comparisons.
 * Object key order is irrelevant while array order remains meaningful; response-only flags are excluded.
 */
/** JSON serialization with recursively sorted object keys and stable array order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}

/** Hashes canonical request content with SHA-256; rejects serialization or Web Crypto failures. */
export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
