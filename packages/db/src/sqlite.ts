import type BetterSqlite3 from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "./schema/sqlite.js";
import { DrizzleStore, type SqliteDb } from "./store.js";
import { DrizzleAuth, type KeyAuth } from "./auth.js";

/**
 * Node: a local SQLite file (or ":memory:") through better-sqlite3 — same schema and migrations as D1.
 * better-sqlite3 is an optional dependency; it is imported lazily so Workers bundles never see it.
 */
export interface SqliteHandle { db: SqliteDb; sqlite: BetterSqlite3.Database; store: DrizzleStore; auth: DrizzleAuth }

export async function fromSqliteFile(path: string, fallbackAuth?: KeyAuth): Promise<SqliteHandle> {
  const { default: Database } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  await applyMigrations(db);
  return { db, sqlite, store: new DrizzleStore(db), auth: new DrizzleAuth(db, fallbackAuth) };
}

/** Minimal surface shared by every Drizzle SQLite driver (sync or async). */
export interface MigratableDb { run(query: unknown): unknown; all(query: unknown): unknown }

/** Apply the drizzle-kit generated SQL files in order, tracked in `__migrations`. D1 uses `wrangler d1 migrations apply` instead. */
export async function applyMigrations(db: MigratableDb, dir = defaultMigrationsDir()) {
  const { sql } = await import("drizzle-orm");
  await db.run(sql`create table if not exists __migrations (name text primary key, applied_at text not null)`);
  const applied = new Set(((await db.all(sql`select name from __migrations`)) as Array<{ name: string }>).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const text = await readFile(join(dir, f), "utf8");
    for (const stmt of text.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await db.run(sql.raw(s));
    }
    await db.run(sql`insert into __migrations (name, applied_at) values (${f}, ${new Date().toISOString()})`);
  }
}

export function defaultMigrationsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
}
