/**
 * Constructs D1 persistence and authentication from a Workers binding.
 * Reservation statements use a D1 batch so the key and initial documents commit atomically.
 */
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "./schema/sqlite.js";
import { DrizzleStore } from "./store.js";
import { DrizzleAuth, type KeyAuth } from "./auth.js";

/** Cloudflare Workers: `const { store, auth } = fromD1(env.DB)`. Migrations are applied with `wrangler d1 migrations apply`. */
export function fromD1(binding: D1Database, fallbackAuth?: KeyAuth) {
  const db = drizzle(binding, { schema });
  return { db, store: new DrizzleStore(db, async statements => {
    const dialect = new SQLiteAsyncDialect();
    await binding.batch(statements.map(statement => {
      const query = dialect.sqlToQuery(statement);
      return binding.prepare(query.sql).bind(...query.params);
    }));
  }), auth: new DrizzleAuth(db, fallbackAuth) };
}
