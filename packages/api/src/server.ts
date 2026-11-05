import { serve } from "@hono/node-server";
import { Engine, FileStore, MemoryStore, type Store } from "@verdict/core";
import { createApp, envAuth, type Auth, type KeyManager } from "./app.js";

/**
 * Node server. Storage, in order of preference:
 *   --database / VERDICT_DATABASE=<file.sqlite>  → Drizzle on better-sqlite3 (same schema + migrations as D1), DB-backed API keys
 *   --data-dir / VERDICT_DATA_DIR=<dir>           → JSON files
 *   (none)                                        → memory
 */
export async function startServer(opts: { port?: number; dataDir?: string; database?: string; allowLocalFiles?: boolean } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const dataDir = opts.dataDir ?? process.env.VERDICT_DATA_DIR;
  const database = opts.database ?? process.env.VERDICT_DATABASE;
  let store: Store;
  let auth: Auth = envAuth();
  let keys: KeyManager | undefined;
  if (database) {
    const { fromSqliteFile } = await import("@verdict/db/sqlite");
    // Env keys stay valid as a bootstrap, but open mode (no VERDICT_API_KEYS) must not bypass the DB keys.
    const h = await fromSqliteFile(database, process.env.VERDICT_API_KEYS ? envAuth() : undefined);
    store = h.store; auth = h.auth; keys = h.auth;
  } else store = dataDir ? new FileStore(dataDir) : new MemoryStore();
  const engine = new Engine({ store, ingest: { allowLocalFiles: opts.allowLocalFiles ?? process.env.VERDICT_ALLOW_LOCAL_FILES === "1" } });
  const app = createApp({ engine, auth, keys, log: process.env.VERDICT_LOG !== "0" });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    const storeName = database ? `sqlite:${database}` : dataDir ? `file:${dataDir}` : "memory";
    console.log(`verdict api listening on http://localhost:${info.port}  (store: ${storeName}, auth: ${database ? "db + env keys" : process.env.VERDICT_API_KEYS ? "env keys" : "open"}${process.env.VERDICT_ADMIN_KEY && keys ? ", admin on" : ""})`);
  });
  return { app, engine, server, port };
}

if (import.meta.url === `file://${process.argv[1]}`) void startServer();
