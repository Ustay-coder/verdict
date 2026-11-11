/**
 * Where `verdict login` keeps API keys: `$XDG_CONFIG_HOME/verdict/hub.json` (default ~/.config), readable only by the
 * user. One key per server address, so a team's own server and a public hub can both be signed in to. CI can skip
 * the file entirely with VERDICT_HUB_URL + VERDICT_HUB_KEY.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FileAccessError, ValidationError } from "@verdict-ai/core";

export interface HubCredentials { hub: string; apiKey: string; keyId?: string; handle?: string }

export interface CredentialStore {
  /** The sign-in saved for `hub`; without an address, the most recent sign-in. */
  read(hub?: string): Promise<HubCredentials | undefined>;
  /** Saves a sign-in for its server and makes it the most recent one. */
  write(c: HubCredentials): Promise<void>;
  /** Forgets the sign-in for `hub`; without an address, the most recent one. */
  remove(hub?: string): Promise<void>;
}

/**
 * The file: the most recent sign-in at the top level — the whole file before servers were kept apart, and still what
 * an older CLI reads — and every sign-in by server address under `servers`.
 */
interface CredentialFile extends Partial<HubCredentials> { servers?: Record<string, Omit<HubCredentials, "hub">> }

const address = (hub: string) => hub.replace(/\/+$/, "");

function signIns(file: CredentialFile | undefined): Map<string, HubCredentials> {
  const all = new Map<string, HubCredentials>();
  for (const [hub, rest] of Object.entries(file?.servers ?? {})) all.set(address(hub), { hub: address(hub), ...rest });
  // A file written before servers were kept apart holds one sign-in and no map.
  if (file?.hub && file.apiKey && !all.has(address(file.hub))) all.set(address(file.hub), { hub: file.hub, apiKey: file.apiKey, ...(file.keyId ? { keyId: file.keyId } : {}), ...(file.handle ? { handle: file.handle } : {}) });
  return all;
}

export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "verdict", "hub.json");
}

export function fileCredentials(path = credentialsPath()): CredentialStore {
  const load = async (): Promise<CredentialFile | undefined> => {
    try { return JSON.parse(await readFile(path, "utf8")) as CredentialFile; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new FileAccessError(path, "read hub credentials", cause);
    }
  };
  const save = async (latest: HubCredentials, all: Map<string, HubCredentials>) => {
    const servers = Object.fromEntries([...all].map(([hub, { hub: _hub, ...rest }]) => [hub, rest]));
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify({ ...latest, servers }, null, 2)}\n`, { mode: 0o600 });
      // why: writeFile's mode only applies to new files; an existing file keeps its old permissions otherwise.
      await chmod(path, 0o600);
    } catch (cause) { throw new FileAccessError(path, "write hub credentials", cause); }
  };
  return {
    async read(hub) {
      const file = await load(), all = signIns(file);
      return all.get(address(hub ?? file?.hub ?? ""));
    },
    async write(c) {
      const all = signIns(await load());
      all.set(address(c.hub), c);
      await save(c, all);
    },
    async remove(hub) {
      const file = await load(), all = signIns(file);
      all.delete(address(hub ?? file?.hub ?? ""));
      // The most recent of what is left takes the top level; nothing left, no file.
      const latest = all.get(address(file?.hub ?? "")) ?? [...all.values()].at(-1);
      if (latest) await save(latest, all);
      else await rm(path, { force: true });
    },
  };
}

/**
 * The hub to talk to and the key for it: flag, then environment, then `configured` (a project's verdict.yaml, for the
 * management commands), then the most recent sign-in. A saved key is used only for the server it was saved for.
 */
export async function hubTarget(store: CredentialStore, env: Record<string, string | undefined>, flag?: string, configured?: string): Promise<{ hub: string; apiKey?: string; saved?: HubCredentials }> {
  const hub = address(flag || env.VERDICT_HUB_URL || configured || (await store.read())?.hub || "");
  if (!hub) throw new ValidationError("no hub configured: pass --hub <url>, set VERDICT_HUB_URL, or sign in with `verdict login --hub <url>`");
  const saved = await store.read(hub);
  const savedForHub = saved && address(saved.hub) === hub ? saved : undefined;
  return { hub, apiKey: env.VERDICT_HUB_KEY || savedForHub?.apiKey, saved: savedForHub };
}
