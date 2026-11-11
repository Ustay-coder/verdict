import { storeOperation } from "./errors.js";
/**
 * Opens Postgres or embedded PGlite and applies generated migrations.
 * Failed startup releases its connection; migration tracking preserves ordered, once-only application.
 */
import type { SQL } from "drizzle-orm";
import { schema } from "./schema/pg.js";
import { PgStore } from "./store.js";
import { DrizzleAuth, type KeyAuth } from "./auth.js";

/** Node-only entry point. Drivers are loaded only when a connection is requested. */
export async function fromPostgres(connectionString: string, fallbackAuth?: KeyAuth, loadDriver: () => Promise<typeof import("pg")> = () => import("pg")) {
  return storeOperation("fromPostgres", async () => {
    const { Pool } = await loadDriver();
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString });
    const db = drizzle(pool, { schema });
    try { await applyPgMigrations(db); }
    catch (cause) { await pool.end(); throw new Error("Postgres initialization failed; check connectivity and migrations", { cause }); }
    return { db, pool, store: new PgStore(db), auth: new DrizzleAuth(db, fallbackAuth, schema.apiKeys), close: () => pool.end() };
  });
}

/** Embedded Postgres for offline tests and local development. */
export async function fromPglite(dataDir?: string, fallbackAuth?: KeyAuth, loadDriver: () => Promise<typeof import("@electric-sql/pglite")> = () => import("@electric-sql/pglite")) {
  return storeOperation("fromPglite", async () => {
    const { PGlite } = await loadDriver();
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite(dataDir);
    const db = drizzle(client, { schema });
    try { await applyPgMigrations(db); }
    catch (cause) { await client.close(); throw new Error("PGlite initialization failed; check the data directory and migrations", { cause }); }
    return { db, client, store: new PgStore(db), auth: new DrizzleAuth(db, fallbackAuth, schema.apiKeys), close: () => client.close() };
  });
}

interface PgMigratableDb {
  execute(query: SQL): PromiseLike<{ rows: unknown[] }>;
}

/** Apply generated migrations in order, tracking completed files. */
export async function applyPgMigrations(db: PgMigratableDb, dir?: string) {
  return storeOperation("applyPgMigrations", async () => {
    const { sql } = await import("drizzle-orm");
    const { readdir, readFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    dir ??= join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "pg");
    await db.execute(sql`create table if not exists __migrations (name text primary key, applied_at text not null)`);
    const applied = new Set((await db.execute(sql`select name from __migrations`)).rows.map(r => (r as { name: string }).name));
    for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) {
      // why: lexical migration names encode generation order; tracked files must never run twice.
      if (applied.has(file)) continue;
      const text = await readFile(join(dir, file), "utf8");
      // why: generated breakpoints separate complete SQL statements, including statements containing semicolons.
      for (const statement of text.split("--> statement-breakpoint")) {
        if (statement.trim()) await db.execute(sql.raw(statement.trim()));
      }
      await db.execute(sql`insert into __migrations (name, applied_at) values (${file}, ${new Date().toISOString()})`);
    }
  });
}
