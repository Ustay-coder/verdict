import { StoreError, storeOperation } from "./errors.js";
/**
 * Opens local SQLite storage and applies generated migrations in order.
 * The optional native driver loads only in Node; migration tracking prevents replaying applied SQL.
 */
import { FileAccessError } from "@verdict-ai/core";
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

/** Opens and migrates SQLite; rejects unavailable drivers, inaccessible paths or migration failures. */
export async function fromSqliteFile(path: string, fallbackAuth?: KeyAuth, loadDriver: () => Promise<{ default: typeof BetterSqlite3 }> = () => import("better-sqlite3")): Promise<SqliteHandle> {
  const { default: Database } = await loadDriver();
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const sqlite = openSqlite(Database, path);
  try {
    // why: WAL lets readers continue while the local evaluation store writes.
    sqlite.pragma("journal_mode = WAL");
    const db = drizzle(sqlite, { schema });
    await applyMigrations(db);
    return { db, sqlite, store: new DrizzleStore(db), auth: new DrizzleAuth(db, fallbackAuth) };
  } catch (cause) {
    sqlite.close();
    throw new StoreError(`initialize SQLite ${path}`, cause);
  }
}

/** Minimal surface shared by every Drizzle SQLite driver (sync or async). */
interface MigratableDb { run(query: unknown): unknown; all(query: unknown): unknown }

/** Apply the drizzle-kit generated SQL files in order, tracked in `__migrations`. D1 uses `wrangler d1 migrations apply` instead. */
export async function applyMigrations(db: MigratableDb, dir = defaultMigrationsDir()) {
  return storeOperation("applyMigrations", async () => {
    const { sql } = await import("drizzle-orm");
    await db.run(sql`create table if not exists __migrations (name text primary key, applied_at text not null)`);
    const applied = new Set(((await db.all(sql`select name from __migrations`)) as Array<{ name: string }>).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      // why: generated file order is migration order; the ledger prevents applying committed migrations twice.
      if (applied.has(f)) continue;
      const text = await readFile(join(dir, f), "utf8");
      for (const stmt of text.split("--> statement-breakpoint")) {
        const s = stmt.trim();
        if (s) await db.run(sql.raw(s));
      }
      await db.run(sql`insert into __migrations (name, applied_at) values (${f}, ${new Date().toISOString()})`);
    }
  });
}

/** Returns the generated SQLite migration directory relative to this module; performs no I/O. */
function defaultMigrationsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
}

// Release belongs to the factory only after opening succeeds; failed migrations must not leak native handles.
function openSqlite(Database: typeof BetterSqlite3, path: string) {
  try { return new Database(path); }
  catch (cause) { throw new FileAccessError(path, "open SQLite database", cause); }
}
