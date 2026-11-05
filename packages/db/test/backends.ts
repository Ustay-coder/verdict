import { afterEach } from "vitest";
import { fromSqliteFile, applyMigrations } from "../src/sqlite.js";
import { fromPglite, applyPgMigrations } from "../src/postgres.js";
import { schema as sqliteSchema } from "../src/schema/sqlite.js";
import { schema as pgSchema } from "../src/schema/pg.js";
import type { KeyAuth } from "../src/auth.js";
import type { SqliteDb } from "../src/store.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
export const backends = [
  { name: "SQLite", open: async (fallback?: KeyAuth) => {
    const h = await fromSqliteFile(":memory:", fallback);
    cleanup.push(() => h.sqlite.close());
    return { ...h, tables: sqliteSchema, migrate: () => applyMigrations(h.db) };
  } },
  { name: "Postgres (PGlite)", open: async (fallback?: KeyAuth) => {
    const h = await fromPglite(undefined, fallback);
    cleanup.push(() => h.close());
    return { ...h, db: h.db as unknown as SqliteDb, tables: pgSchema as unknown as typeof sqliteSchema, migrate: () => applyPgMigrations(h.db) };
  } },
];
