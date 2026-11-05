import { eq } from "drizzle-orm";
import { apiKeys } from "./schema/sqlite.js";
import type { SqliteDb } from "./store.js";

/** Structurally identical to @verdict/api's `Auth` — kept local so db does not depend on api. */
export interface KeyAuth { resolve(apiKey: string | undefined): Promise<string | undefined> | string | undefined }

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomKey(prefix = "vk_live_") {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** API keys stored hashed in the `api_keys` table. `fallback` lets env-configured keys keep working (bootstrap). */
export class DrizzleAuth implements KeyAuth {
  constructor(private db: SqliteDb, private fallback?: KeyAuth) {}

  async resolve(key: string | undefined): Promise<string | undefined> {
    if (!key) return await this.fallback?.resolve(key);
    const hash = await sha256Hex(key);
    const rows = await this.db.select({ id: apiKeys.id, tenantId: apiKeys.tenantId, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    if (!row) return await this.fallback?.resolve(key);
    if (row.revokedAt) return undefined;
    // Fire-and-forget touch; never block auth on it.
    void Promise.resolve(this.db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKeys.id, row.id))).catch(() => {});
    return row.tenantId;
  }

  /** Create a key. Returns the plaintext exactly once. */
  async createKey(tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }> {
    const key = randomKey();
    const id = `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const prefix = key.slice(0, 12);
    await this.db.insert(apiKeys).values({ id, tenantId, name, keyHash: await sha256Hex(key), prefix, createdAt: new Date().toISOString() });
    return { id, key, prefix };
  }

  async revokeKey(id: string, tenantId?: string): Promise<boolean> {
    const rows = await this.db.select({ tenantId: apiKeys.tenantId }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    if (!rows[0] || (tenantId !== undefined && rows[0].tenantId !== tenantId)) return false;
    await this.db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, id));
    return true;
  }

  async listKeys(tenantId: string) {
    return this.db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
  }
}
