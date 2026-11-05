import { serve } from "@hono/node-server";
import { Engine, MemoryQueue, FileStore, MemoryStore, type Store } from "@verdict/core";
import { createApp, envAuth, type Auth, type KeyManager } from "./app.js";

/**
 * Node server. Storage, in order of preference:
 *   --database / VERDICT_DATABASE=<file.sqlite|postgres://…> → SQLite or Postgres, DB-backed API keys
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
    const open = /^postgres(ql)?:\/\//.test(database)
      ? (await import("@verdict/db/postgres")).fromPostgres
      : (await import("@verdict/db/sqlite")).fromSqliteFile;
    // Env keys stay valid as a bootstrap, but open mode (no VERDICT_API_KEYS) must not bypass the DB keys.
    const h = await open(database, process.env.VERDICT_API_KEYS ? envAuth() : undefined);
    store = h.store; auth = h.auth; keys = h.auth;
  } else store = dataDir ? new FileStore(dataDir) : new MemoryStore();
  const queue = new MemoryQueue();
  const engine = new Engine({ store, queue, ingest: { allowLocalFiles: opts.allowLocalFiles ?? process.env.VERDICT_ALLOW_LOCAL_FILES === "1" } });
  queue.engine = engine;
  const app = createApp({ engine, auth, keys, log: process.env.VERDICT_LOG !== "0" });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    const storeName = database ? (/^postgres(ql)?:\/\//.test(database) ? "postgres" : `sqlite:${database}`) : dataDir ? `file:${dataDir}` : "memory";
    console.log(`verdict api listening on http://localhost:${info.port}  (store: ${storeName}, auth: ${database ? "db + env keys" : process.env.VERDICT_API_KEYS ? "env keys" : "open"}${process.env.VERDICT_ADMIN_KEY && keys ? ", admin on" : ""})`);
  });
  process.once("SIGTERM", () => {
    const keepAlive = setInterval(() => {}, 1000);
    server.close(() => { void queue.drain().then(() => { clearInterval(keepAlive); process.exit(0); }); });
  });
  return { app, engine, server, port };
}

if (import.meta.url === `file://${process.argv[1]}`) void startServer();
