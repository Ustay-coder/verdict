import { serve } from "@hono/node-server";
import { Engine, FileStore, MemoryStore } from "@verdict/core";
import { createApp, envAuth } from "./app.js";

export function startServer(opts: { port?: number; dataDir?: string; allowLocalFiles?: boolean } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const dataDir = opts.dataDir ?? process.env.VERDICT_DATA_DIR;
  const engine = new Engine({
    store: dataDir ? new FileStore(dataDir) : new MemoryStore(),
    ingest: { allowLocalFiles: opts.allowLocalFiles ?? process.env.VERDICT_ALLOW_LOCAL_FILES === "1" },
  });
  const app = createApp({ engine, auth: envAuth(), log: process.env.VERDICT_LOG !== "0" });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`verdict api listening on http://localhost:${info.port}  (store: ${dataDir ? `file:${dataDir}` : "memory"}, auth: ${process.env.VERDICT_API_KEYS ? "api keys" : "open"})`);
  });
  return { app, engine, server, port };
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
