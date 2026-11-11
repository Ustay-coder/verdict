/**
 * Registers `verdict watch`: a live local page over the evaluations in the data directory.
 * The server only reads the store; it binds to 127.0.0.1 by default because the page shows evaluated text.
 */
import { FileStore, hasVersions, type Store } from "@verdict-ai/core";
import { Command } from "commander";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { dataDir } from "../remote.js";
import { compareView } from "../watch/compare-state.js";
import { comparePage, watchPage } from "../watch/page.js";
import { watchState } from "../watch/state.js";

// why: the page polls about once a second; a bounded read keeps each poll cheap on a long-lived data directory.
const WATCH_EVALUATION_LIMIT = 500;

/** Serves the page and its state; a store failure answers 500 with the message instead of crashing the server. */
export function createWatchServer(store: Store, source?: string): Server {
  return createServer((req, res) => { void handle(store, source, req, res); });
}

async function handle(store: Store, source: string | undefined, req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/compare") {
      if (!hasVersions(store)) throw new Error("this store keeps no runs");
      const q = url.searchParams;
      const view = await compareView(store, { base: q.get("base") ?? undefined, head: q.get("head") ?? undefined, labels: q.get("labels") ?? undefined });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(view));
    } else if (url.pathname === "/compare") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(comparePage(source));
    } else if (req.url?.startsWith("/api/state")) {
      const state = watchState(await store.listEvaluations({ limit: WATCH_EVALUATION_LIMIT }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(state));
    } else if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(watchPage(source));
    } else res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

type WatchDependencies = Pick<CommandDependencies, "out"> & {
  store: (directory: string) => Store; directory: () => string;
  listen: (server: Server, port: number, host: string) => Promise<void>;
};

const listen = (server: Server, port: number, host: string) => new Promise<void>((resolve) => server.listen(port, host, resolve));

/** Registers the watch command; it resolves once the server is listening and keeps the process alive. */
export function registerWatch(program: Command, deps: WatchDependencies = { out: commandDefaults.out, store: (d) => new FileStore(d), directory: dataDir, listen }) {
  program.command("watch").description("serve a live page of the evaluations in .verdict/ (or VERDICT_DATA_DIR): scores, gates, changed lines, leaderboards, and /compare for runs")
    .option("-p, --port <port>", "port", "4600").option("--host <host>", "host", "127.0.0.1")
    .action(async (o: { port: string; host: string }) => {
      const directory = deps.directory();
      const server = createWatchServer(deps.store(directory), directory);
      await deps.listen(server, Number(o.port), o.host);
      deps.out(`verdict watch on http://${o.host}:${o.port}/  (reading ${directory})`);
    });
}
