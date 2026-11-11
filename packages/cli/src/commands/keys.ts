import { Command } from "commander";
import { commandDefaults, type CommandDependencies } from "../command-deps.js";

interface KeyHandle { auth: Pick<import("@verdict-ai/db").DrizzleAuth, "createKey" | "listKeys" | "revokeKey">; close(): void | Promise<void> }

async function openDatabase(database: string): Promise<KeyHandle> {
  // why: URL selection keeps optional native drivers out of Postgres and Workers callers.
  if (/^postgres(ql)?:\/\//.test(database)) {
    const handle = await (await import("@verdict-ai/db/postgres")).fromPostgres(database);
    return { auth: handle.auth, close: handle.close };
  }
  const handle = await (await import("@verdict-ai/db/sqlite")).fromSqliteFile(database);
  return { auth: handle.auth, close: () => { handle.sqlite.close(); } };
}

type KeyDependencies = CommandDependencies & { open: typeof openDatabase };

/** Connection cleanup belongs to each invocation, including failed key operations. */
export function registerKeys(program: Command, deps: KeyDependencies = { ...commandDefaults, open: openDatabase }) {
  const keys = program.command("keys").description("manage API keys in a SQLite or Postgres database (--database)");
  const withAuth = async (database: string, run: (auth: Awaited<ReturnType<typeof openDatabase>>["auth"]) => Promise<void>) => {
    const handle = await deps.open(database);
    try { await run(handle.auth); }
    finally { await handle.close(); }
  };
  keys.command("create").requiredOption("--database <path-or-url>").requiredOption("--tenant <id>").requiredOption("--name <name>").action(async (o: KeyOptions) => {
    await withAuth(o.database, async auth => {
      const key = await auth.createKey(o.tenant, o.name);
      // why: plaintext is returned only at creation; subsequent listings expose the prefix alone.
      deps.out(`${key.key}\n(id ${key.id}; shown once — store it now)`);
    });
  });
  keys.command("list").requiredOption("--database <path-or-url>").requiredOption("--tenant <id>").action(async (o: KeyOptions) => {
    await withAuth(o.database, async auth => {
      for (const key of await auth.listKeys(o.tenant)) deps.out(`${key.id}\t${key.prefix}…\t${key.name}\t${key.revokedAt ? "revoked" : "active"}\tlast used ${key.lastUsedAt ?? "never"}`);
    });
  });
  keys.command("revoke <id>").requiredOption("--database <path-or-url>").action(async (id: string, o: Pick<KeyOptions, "database">) => {
    await withAuth(o.database, async auth => { deps.out(await auth.revokeKey(id) ? "revoked" : "not found"); });
  });
}

interface KeyOptions { database: string; tenant: string; name: string }
