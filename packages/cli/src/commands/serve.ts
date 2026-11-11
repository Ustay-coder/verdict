/**
 * Registers the serve command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { Command } from "commander";

/** Registers serve operations; handler failures propagate to the transport error boundary. */
export function registerServe(program: Command) {
  program.command("serve").description("run the HTTP API").option("-p, --port <port>", "port", "8787").option("--database <path-or-url>", "SQLite file or Postgres URL; enables DB-managed API keys").option("--data-dir <dir>", "persist as JSON files").option("--allow-local-files").action(async (o: ServeOptions) => {
    const { startServer } = await import("@verdict-ai/api/server");
    await startServer({ port: Number(o.port), database: o.database, dataDir: o.dataDir, allowLocalFiles: !!o.allowLocalFiles });
  });

}

interface ServeOptions { port: string; database?: string; dataDir?: string; allowLocalFiles?: boolean; }
