import type { SQL } from "drizzle-orm";
import { schema } from "./schema/pg.js";
import { PgStore } from "./store.js";
import { DrizzleAuth, type KeyAuth } from "./auth.js";

/** Node-only entry point. Drivers are loaded only when a connection is requested. */
export async function fromPostgres(connectionString: string, fallbackAuth?: KeyAuth) {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  try { await applyPgMigrations(db); }
  catch (error) { await pool.end(); throw error; }
  return { db, pool, store: new PgStore(db), auth: new DrizzleAuth(db, fallbackAuth, schema.apiKeys), close: () => pool.end() };
}

/** Embedded Postgres for offline tests and local development. */
export async function fromPglite(dataDir?: string, fallbackAuth?: KeyAuth) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  try { await applyPgMigrations(db); }
  catch (error) { await client.close(); throw error; }
  return { db, client, store: new PgStore(db), auth: new DrizzleAuth(db, fallbackAuth, schema.apiKeys), close: () => client.close() };
}

export interface PgMigratableDb {
  execute(query: SQL): PromiseLike<{ rows: unknown[] }>;
}

/** Apply generated migrations in order, tracking completed files. */
export async function applyPgMigrations(db: PgMigratableDb, dir?: string) {
  const { sql } = await import("drizzle-orm");
  const { readdir, readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  dir ??= join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "pg");
  await db.execute(sql`create table if not exists __migrations (name text primary key, applied_at text not null)`);
  const applied = new Set((await db.execute(sql`select name from __migrations`)).rows.map(r => (r as { name: string }).name));
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const text = await readFile(join(dir, file), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.execute(sql.raw(statement.trim()));
    }
    await db.execute(sql`insert into __migrations (name, applied_at) values (${file}, ${new Date().toISOString()})`);
  }
}
