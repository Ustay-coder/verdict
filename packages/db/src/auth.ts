/**
 * Plaintext keys are returned once; revocation takes precedence over bootstrap authentication.
 */
import { ValidationError, type Actor } from "@verdict-ai/core";
import { storeOperation } from "./errors.js";
import { DocumentQueries, sqliteQueries, postgresQueries } from "./queries.js";
import { schema as sqliteSchema } from "./schema/sqlite.js";
import { schema as pgSchema } from "./schema/pg.js";
import { eq } from "drizzle-orm";
import { apiKeys as sqliteApiKeys } from "./schema/sqlite.js";
import type { SqliteDb } from "./store.js";
import type { PgDb } from "./dialects.js";
import type { apiKeys as pgApiKeys } from "./schema/pg.js";

/** A tenant and the key that asked, so history can say who changed what. */
export interface KeyIdentity { tenantId: string; actor: Actor }

/** Structurally identical to @verdict-ai/api's `Auth` — kept local so db does not depend on api. */
export interface KeyAuth { resolve(apiKey: string | undefined, request?: Request): Promise<string | KeyIdentity | undefined> | string | KeyIdentity | undefined }

/** Hashes UTF-8 input as hexadecimal SHA-256; rejects Web Crypto failures. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const KEY_ENTROPY_BYTES = 24;
const DISPLAY_PREFIX_CHARS = 12;

function randomKey(prefix = "vk_live_") {
  // why: 24 random bytes provide 192 bits of key entropy; the prefix is only an operator hint.
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_ENTROPY_BYTES));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** API keys stored hashed in the `api_keys` table. `fallback` lets env-configured keys keep working (bootstrap). */
export class DrizzleAuth implements KeyAuth {
  private queries: DocumentQueries;
  constructor(db: SqliteDb, fallback?: KeyAuth, apiKeys?: typeof sqliteApiKeys, onError?: (error: unknown) => void);
  constructor(db: PgDb, fallback: KeyAuth | undefined, apiKeys: typeof pgApiKeys, onError?: (error: unknown) => void);
  constructor(db: SqliteDb | PgDb, private fallback?: KeyAuth, apiKeys: typeof sqliteApiKeys | typeof pgApiKeys = sqliteApiKeys, private onError: (error: unknown) => void = console.error) {
    // why: constructor overloads pair the driver with its schema; raw rows use that dialect's own column codecs.
    this.queries = apiKeys === sqliteApiKeys ? sqliteQueries(db as SqliteDb, sqliteSchema) : postgresQueries(db as PgDb, pgSchema);
  }

  /** A stored key resolves to its tenant and its own id and name; fallback keys resolve to whatever the fallback says. */
  async resolve(key: string | undefined, request?: Request): Promise<string | KeyIdentity | undefined> {
    return storeOperation("auth.resolve", async () => {
      if (!key) return await this.fallback?.resolve(key, request);
      const hash = await sha256Hex(key);
      const rows = await this.queries.select("apiKeys", { where: eq(this.queries.tables.apiKeys.keyHash, hash), limit: 1 });
      const row = rows[0];
      if (!row) return await this.fallback?.resolve(key, request);
      // why: a revoked database key must not regain access through bootstrap fallback authentication.
      if (row.revokedAt) return undefined;
      // why: last-used telemetry is advisory; a failed touch must not deny an otherwise valid key.
      void Promise.resolve(this.queries.update("apiKeys", { lastUsedAt: new Date().toISOString() }, eq(this.queries.tables.apiKeys.id, row.id))).catch(error => this.onError(error));
      return { tenantId: row.tenantId, actor: { kind: "key" as const, id: row.id, name: row.name } };
    });
  }

  /** Create a key. Returns the plaintext exactly once. */
  async createKey(tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }> {
    if (!tenantId.trim() || !name.trim()) throw new ValidationError("key tenant and name must not be empty");
    return storeOperation(`auth.createKey:${tenantId}`, async () => {
      const key = randomKey();
      const id = `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const prefix = key.slice(0, DISPLAY_PREFIX_CHARS);
      await this.queries.insert("apiKeys", [{ id, tenantId, name, keyHash: await sha256Hex(key), prefix, createdAt: new Date().toISOString() }]);
      return { id, key, prefix };
    });
  }

  async revokeKey(id: string, tenantId?: string): Promise<boolean> {
    return storeOperation("auth.revokeKey", async () => {
      const rows = await this.queries.select("apiKeys", { where: eq(this.queries.tables.apiKeys.id, id), limit: 1 });
      if (!rows[0] || (tenantId !== undefined && rows[0].tenantId !== tenantId)) return false;
      await this.queries.update("apiKeys", { revokedAt: new Date().toISOString() }, eq(this.queries.tables.apiKeys.id, id));
      return true;
    });
  }

  async listKeys(tenantId: string) {
    return storeOperation("auth.listKeys", async () => {
      const rows = await this.queries.select("apiKeys", { where: eq(this.queries.tables.apiKeys.tenantId, tenantId) });
      // why: key hashes and tenant internals are never part of the key-management response.
      return rows.map(({ id, name, prefix, createdAt, lastUsedAt, revokedAt }) => ({ id, name, prefix, createdAt, lastUsedAt, revokedAt }));
    });
  }
}
