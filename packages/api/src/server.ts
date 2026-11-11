/**
 * Starts the Node HTTP surface with environment-selected persistence.
 * Database keys retain bootstrap authentication; shutdown drains queued work before exiting.
 */
import { serve } from "@hono/node-server";
import { lazyPlaywrightScreenshot, Engine, MemoryQueue, FileStore, MemoryStore, type Store } from "@verdict-ai/core";
import type { Context } from "hono";
import { createApp, envAuth, routeGroups, type Auth, type KeyManager } from "./app.js";

export interface ServerOptions {
  port?: number; dataDir?: string; database?: string; allowLocalFiles?: boolean;
  store?: Store; queue?: MemoryQueue;
  loadDatabase?: (kind: "postgres" | "sqlite") => Promise<{ open: typeof import("@verdict-ai/db/postgres").fromPostgres | typeof import("@verdict-ai/db/sqlite").fromSqliteFile }>;
}

// Keep environment interpretation at startup so storage and queue dependencies can be supplied by tests.
function serverConfig(opts: ServerOptions, env = process.env) {
  return {
    port: opts.port ?? Number(env.PORT ?? 8787),
    dataDir: opts.dataDir ?? env.VERDICT_DATA_DIR,
    database: opts.database ?? env.VERDICT_DATABASE,
    allowLocalFiles: opts.allowLocalFiles ?? env.VERDICT_ALLOW_LOCAL_FILES === "1",
    // why: a headless browser per request is costly and fetches arbitrary URLs; servers opt in explicitly.
    screenshots: env.VERDICT_SCREENSHOTS === "1",
    log: env.VERDICT_LOG !== "0", apiKeys: env.VERDICT_API_KEYS, adminKey: env.VERDICT_ADMIN_KEY,
    github: env.GITHUB_CLIENT_ID ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : undefined,
    routes: routeGroups(env.VERDICT_ROUTES),
  };
}

/** Starts the Node server using supplied or environment-selected adapters; startup failures reject. */
export async function startServer(opts: ServerOptions = {}) {
  const config = serverConfig(opts);
  const { port, dataDir, database } = config;
  let store: Store;
  let auth: Auth = envAuth();
  let keys: KeyManager | undefined;
  if (opts.store) store = opts.store;
  else if (database) {
    const kind = /^postgres(ql)?:\/\//.test(database) ? "postgres" : "sqlite";
    const { open } = await (opts.loadDatabase ?? loadDatabase)(kind);
    // Env keys stay valid as a bootstrap, but open mode (no VERDICT_API_KEYS) must not bypass the DB keys.
    const h = await open(database, config.apiKeys ? envAuth() : undefined);
    store = h.store; auth = h.auth; keys = h.auth;
  } else store = dataDir ? new FileStore(dataDir) : new MemoryStore();
  const queue = opts.queue ?? new MemoryQueue();
  const engine = new Engine({ store, queue, ingest: { allowLocalFiles: config.allowLocalFiles, screenshot: config.screenshots ? lazyPlaywrightScreenshot() : undefined } });
  queue.engine = engine;
  const app = createApp({ engine, auth, keys, log: config.log, github: config.github, clientKey: socketAddress, routes: config.routes });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    const storeName = database ? (/^postgres(ql)?:\/\//.test(database) ? "postgres" : `sqlite:${database}`) : dataDir ? `file:${dataDir}` : "memory";
    console.log(`verdict api listening on http://localhost:${info.port}  (store: ${storeName}, auth: ${database ? "db + env keys" : config.apiKeys ? "env keys" : "open"}${config.adminKey && keys ? ", admin on" : ""})`);
  });
  process.once("SIGTERM", () => {
    // why: retry timers are unreferenced; keep Node alive until delayed work drains during graceful shutdown.
    const keepAlive = setInterval(() => {}, 1000);
    server.close(() => { void queue.drain().then(() => { clearInterval(keepAlive); process.exit(0); }); });
  });
  return { app, engine, server, port };
}

// Driver imports belong at startup so the Node factory can be exercised without native modules.
async function loadDatabase(kind: "postgres" | "sqlite") {
  if (kind === "postgres") return { open: (await import("@verdict-ai/db/postgres")).fromPostgres };
  return { open: (await import("@verdict-ai/db/sqlite")).fromSqliteFile };
}

if (import.meta.url === `file://${process.argv[1]}`) void startServer();

/** The Node server limits per socket address: behind a proxy that is the proxy's, so put limits at the proxy too. */
function socketAddress(c: Context): string {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "anonymous";
}
