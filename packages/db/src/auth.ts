import { eq } from "drizzle-orm";
import { apiKeys as sqliteApiKeys } from "./schema/sqlite.js";
import type { SqliteDb } from "./store.js";
import type { PgDb } from "./dialects.js";
import type { apiKeys as pgApiKeys } from "./schema/pg.js";

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
  private db: SqliteDb;
  private apiKeys: typeof sqliteApiKeys;
  constructor(db: SqliteDb | PgDb, private fallback?: KeyAuth, apiKeys: typeof sqliteApiKeys | typeof pgApiKeys = sqliteApiKeys) {
    // Both drivers expose these same select/insert/update operations. Keep the
    // dialect type bridge here, while preserving typed rows in the shared logic.
    this.db = db as unknown as SqliteDb;
    this.apiKeys = apiKeys as unknown as typeof sqliteApiKeys;
  }

  async resolve(key: string | undefined): Promise<string | undefined> {
    if (!key) return await this.fallback?.resolve(key);
    const hash = await sha256Hex(key);
    const rows = await this.db.select({ id: this.apiKeys.id, tenantId: this.apiKeys.tenantId, revokedAt: this.apiKeys.revokedAt }).from(this.apiKeys).where(eq(this.apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    if (!row) return await this.fallback?.resolve(key);
    if (row.revokedAt) return undefined;
    // Fire-and-forget touch; never block auth on it.
    void Promise.resolve(this.db.update(this.apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(this.apiKeys.id, row.id))).catch(() => {});
    return row.tenantId;
  }

  /** Create a key. Returns the plaintext exactly once. */
  async createKey(tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }> {
    const key = randomKey();
    const id = `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const prefix = key.slice(0, 12);
    await this.db.insert(this.apiKeys).values({ id, tenantId, name, keyHash: await sha256Hex(key), prefix, createdAt: new Date().toISOString() });
    return { id, key, prefix };
  }

  async revokeKey(id: string, tenantId?: string): Promise<boolean> {
    const rows = await this.db.select({ tenantId: this.apiKeys.tenantId }).from(this.apiKeys).where(eq(this.apiKeys.id, id)).limit(1);
    if (!rows[0] || (tenantId !== undefined && rows[0].tenantId !== tenantId)) return false;
    await this.db.update(this.apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(this.apiKeys.id, id));
    return true;
  }

  async listKeys(tenantId: string) {
    return this.db.select({ id: this.apiKeys.id, name: this.apiKeys.name, prefix: this.apiKeys.prefix, createdAt: this.apiKeys.createdAt, lastUsedAt: this.apiKeys.lastUsedAt, revokedAt: this.apiKeys.revokedAt }).from(this.apiKeys).where(eq(this.apiKeys.tenantId, tenantId));
  }
}
