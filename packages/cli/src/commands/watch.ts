/**
 * Registers `verdict watch`: a live local page over the evaluations in the data directory.
 * The evaluation and comparison pages only read the store. The change-test pages also write — a test, its expectations,
 * a trial — so those requests are guarded (`watch/change-server.ts`) and switched off when the server is not bound to
 * this machine alone. It binds to 127.0.0.1 by default because the page shows evaluated text.
 */
import { Engine, FileStore, hasChangeTests, hasVersions, type Store } from "@verdict-ai/core";
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { dataDir, localEngine } from "../remote.js";
import { handleChange, type ChangeContext } from "../watch/change-server.js";
import { compareView } from "../watch/compare-state.js";
import { changePage, comparePage, watchPage } from "../watch/page.js";
import { watchState } from "../watch/state.js";

// why: the page polls about once a second; a bounded read keeps each poll cheap on a long-lived data directory.
const WATCH_EVALUATION_LIMIT = 500;

export interface WatchServerOptions {
  /** Runs the trials started from the page. Without one the change-test pages are read-only. */
  engine?: Engine;
  /** Why writes are off, when they are (not bound to this machine, or asked for). */
  readOnly?: string;
  env?: (name: string) => string | undefined;
}

/** `pid:1234` names a process on this machine; anything else cannot be checked and counts as gone. */
function runnerAlive(runner: string | undefined): boolean {
  const pid = Number(/^pid:(\d+)$/.exec(runner ?? "")?.[1]);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function changeContext(store: Store, opts: WatchServerOptions): ChangeContext | undefined {
  if (!hasVersions(store) || !hasChangeTests(store)) return undefined;
  const readOnly = opts.readOnly ?? (opts.engine ? undefined : "this server was started without an engine");
  return {
    engine: opts.engine ?? new Engine({ store }), store: store as ChangeContext["store"], writable: !readOnly, ...(readOnly ? { readOnlyReason: readOnly } : {}),
    token: randomBytes(16).toString("hex"), env: opts.env ?? ((name) => process.env[name]), active: new Map(), starting: Promise.resolve(), runner: `pid:${process.pid}`, alive: runnerAlive,
  };
}

/** Serves the pages and their state; a store failure answers 500 with the message instead of crashing the server. */
export function createWatchServer(store: Store, source?: string, opts: WatchServerOptions = {}): Server {
  const change = changeContext(store, opts);
  return createServer((req, res) => { void handle({ store, source, change }, req, res); });
}

async function handle(ctx: { store: Store; source?: string; change?: ChangeContext }, req: IncomingMessage, res: ServerResponse) {
  const { store, source } = ctx;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (ctx.change && await handleChange(ctx.change, url, req, res)) return;
    if (url.pathname === "/change-tests" && ctx.change) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(changePage(source, ctx.change.token));
    } else if (url.pathname === "/api/compare") {
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
  /** The engine that runs trials started from the page; it must write to the store the page reads. */
  engine?: (directory: string) => Engine;
};

const listen = (server: Server, port: number, host: string) => new Promise<void>((resolve) => server.listen(port, host, resolve));
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Registers the watch command; it resolves once the server is listening and keeps the process alive. */
export function registerWatch(program: Command, deps: WatchDependencies = { out: commandDefaults.out, store: (d) => new FileStore(d), directory: dataDir, listen, engine: localEngine }) {
  program.command("watch").description("serve a live page of the evaluations in .verdict/ (or VERDICT_DATA_DIR): scores, gates, changed lines, leaderboards, /compare for runs and /change-tests for rubric changes")
    .option("-p, --port <port>", "port", "4600").option("--host <host>", "host", "127.0.0.1")
    .option("--read-only", "serve stored results only: no test, expectation or trial can be created from the page")
    .action(async (o: { port: string; host: string; readOnly?: boolean }) => {
      const directory = deps.directory();
      const engine = deps.engine?.(directory);
      const readOnly = o.readOnly ? "started with --read-only" : LOOPBACK.has(o.host) ? undefined : `bound to ${o.host}, which other machines can reach`;
      const server = createWatchServer(engine?.store ?? deps.store(directory), directory, { ...(engine ? { engine } : {}), ...(readOnly ? { readOnly } : {}) });
      await deps.listen(server, Number(o.port), o.host);
      deps.out(`verdict watch on http://${o.host}:${o.port}/  (reading ${directory})`);
      if (readOnly) deps.out(`change tests are read-only: ${readOnly}`);
    });
}
