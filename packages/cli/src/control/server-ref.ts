/**
 * A rubric named on a server instead of read from a file (docs/design/control-plane.md C25, C26): the version an
 * environment runs (`intent` with `--env prod`), the newest one uploaded (`intent@latest`), or one version
 * (`intent@rv_…`). Sign in once on a machine and any of them can be judged with there; no rubric file is needed.
 *
 * The server is not trusted to name what it sent: the document is frozen here and used only when it freezes to the id
 * asked for or named. What was fetched is kept in the local data directory, so a version already held is not asked for
 * again. Judging still happens on this machine, with this machine's model keys.
 */
import { CONTROL_NAME, freezeRubric, hasVersions, ValidationError, type Rubric, type RubricVersion, type VersionStore } from "@verdict-ai/core";
import { VerdictError } from "@verdict-ai/sdk";

import { hubDefaults, withHub, type HubDependencies } from "../hub/deps.js";
import { mockify } from "../mock.js";
import { mocked, resolveVersion, type Workspace } from "../versions/workspace.js";
import { addTargetOptions, asking, controlTarget, type ControlTarget, type TargetOptions } from "./target.js";

export type ServerRef = { name: string } & ({ env: string } | { latest: true } | { versionId: string });
export interface ServerRefOptions extends TargetOptions { env?: string }

const VERSION_ID = /^rv_[0-9a-f]{20}$/;

/** The ways to say which version, for messages. */
const ways = (name: string) => `\`${name} --env <environment>\` (what it runs), \`${name}@latest\` (the newest uploaded) or \`${name}@rv_…\``;

/**
 * Reads `ref` as a rubric on a server, or resolves undefined when it is something else: a file, a local version id,
 * a stored rubric id. A bare name is a server reference only with `--env`; without it the name keeps the meaning it
 * had before (and `--env` never changes what a file or an id means).
 */
export function serverRef(ref: string, o: Pick<ServerRefOptions, "env">): ServerRef | undefined {
  const [name = "", at, ...more] = ref.split("@");
  if (more.length || !CONTROL_NAME.test(name)) return undefined;
  if (at === undefined) return o.env ? { name, env: o.env } : undefined;
  if (o.env) throw new ValidationError(`${ref}: name a version or an environment, not both — drop --env or the part after @`);
  if (at === "latest") return { name, latest: true };
  if (VERSION_ID.test(at)) return { name, versionId: at };
  throw new ValidationError(`${ref}: after @ comes \`latest\` or a version id (rv_…)`);
}

/** The options of a command that accepts a rubric by its name on a server. `withTarget: false` where they are there already. */
export function addServerRefOptions<T extends { option(flags: string, description?: string): T }>(command: T, withTarget = true): T {
  const base = command.option("--env <name>", "with a rubric name instead of a file: use the version this environment runs on your team's server");
  return withTarget ? addTargetOptions(base) : base;
}

export interface Fetched { name: string; version: RubricVersion; /** One line for the person: which version, and why that one. */ said: string }

/** Used only if it is what was named: a changed or cut-off answer is refused, not judged with. */
async function verified(target: ControlTarget, name: string, id: string, rubric: unknown, extra: Pick<RubricVersion, "parentVersionId" | "fork"> & { createdAt?: string } = {}): Promise<RubricVersion> {
  const frozen = await freezeRubric(rubric);
  if (frozen.id !== id) throw new ValidationError(`${target.server} named ${id} for ${name}, but the rubric it sent freezes to ${frozen.id}; nothing was used`);
  return { ...frozen, ...(extra.parentVersionId ? { parentVersionId: extra.parentVersionId } : {}), ...(extra.fork ? { fork: extra.fork } : {}), ...(extra.createdAt ? { createdAt: extra.createdAt } : {}) };
}

const notFound = (e: unknown) => e instanceof VerdictError && e.status === 404;

/** "What does it run now" needs the server; a version by id does not, once it has been here. */
function unreachable(e: unknown, target: ControlTarget, name: string): never {
  if (e instanceof VerdictError && (e.type === "network" || e.type === "timeout")) throw new ValidationError(`cannot reach ${target.server} to ask which version of ${name} that is; a version this machine already holds runs without the server: \`${name}@rv_…\` (\`verdict version list\` shows them)`);
  throw e;
}

async function byId(target: ControlTarget, name: string, id: string): Promise<RubricVersion> {
  const where = `${target.project} on ${target.server}`;
  try {
    const view = await asking(target, (client) => client.versions.get(target.project, name, id));
    return await verified(target, name, id, view.rubric, view);
  } catch (e) {
    if (notFound(e)) throw new ValidationError(`${where} keeps no version ${id} of ${name}; \`verdict push\` uploads one`);
    throw e;
  }
}

/** Fetches what `ref` names, or takes it from `store` when a named version is already there. */
export async function fetchServerVersion(deps: HubDependencies, store: VersionStore | undefined, ref: ServerRef, o: ServerRefOptions): Promise<Fetched> {
  const { name } = ref;
  const remember = async (version: RubricVersion): Promise<RubricVersion> => {
    if (!store) return version;
    const held = await store.getRubricVersion(version.id);
    if (!held) await store.putRubricVersion(version);
    return held ?? version;
  };
  if ("versionId" in ref) {
    // A version never changes, so one already here is the one asked for: no sign-in or network is needed.
    const held = await store?.getRubricVersion(ref.versionId);
    if (held) return { name, version: held, said: `${name}: ${held.id} (already on this machine)` };
    const target = await controlTarget(deps, o);
    return { name, version: await remember(await byId(target, name, ref.versionId)), said: `${name}: ${ref.versionId} from ${target.project} on ${target.server}` };
  }
  const target = await controlTarget(deps, o), where = `${target.project} on ${target.server}`;
  if ("latest" in ref) {
    const { data } = await asking(target, (client) => client.versions.list(target.project, name, { limit: 1 })).catch((e: unknown) => unreachable(e, target, name));
    const newest = data[0];
    if (!newest) throw new ValidationError(`${where} keeps no version of ${name}; \`verdict push <file> --name ${name}\` uploads one`);
    const version = (await store?.getRubricVersion(newest.id)) ?? (await remember(await byId(target, name, newest.id)));
    return { name, version, said: `${name}: ${version.id}, the newest version in ${where}` };
  }
  // One answer holds the pointer and its document, and a key that may only read environments (a service's) gets it.
  const environment = await asking(target, (client) => client.environments.get(target.project, ref.env, { include: "rubrics" })).catch((e: unknown) => {
    if (notFound(e)) throw new ValidationError(`${where} has no environment ${ref.env}`);
    return unreachable(e, target, name);
  });
  const pointer = environment.pointers.find((p) => p.name === name);
  if (!pointer) {
    const runs = environment.pointers.map((p) => p.name);
    throw new ValidationError(`${ref.env} in ${where} does not run ${name}${runs.length ? `; it runs ${runs.join(", ")}` : "; nothing has been promoted to it yet"}`);
  }
  const version = await remember(await verified(target, name, pointer.versionId, pointer.rubric));
  return { name, version, said: `${name}: ${version.id}, what ${ref.env} runs in ${where}` };
}

/**
 * A reference as a version, for the commands that keep runs: one a server keeps, else a rubric file or a version in
 * the local data directory. `name` is set when the reference itself said what the rubric is called on the server.
 */
export async function resolveRef(ws: Workspace, ref: string, o: ServerRefOptions): Promise<{ version: RubricVersion; file?: string; name?: string }> {
  const named = serverRef(ref, o);
  if (!named) {
    if (CONTROL_NAME.test(ref) && !(await ws.store.getRubricVersion(ref))) throw new ValidationError(`${ref} is not a rubric file or a version in this data directory; to use what a server keeps under that name, say which version: ${ways(ref)}`);
    return resolveVersion(ws, ref);
  }
  const fetched = await fetchServerVersion(withHub(ws.deps), ws.store, named, o);
  ws.deps.warn(fetched.said);
  return { version: ws.mock ? await mocked(ws, fetched.version) : fetched.version, name: named.name };
}

export interface RubricRefOptions extends ServerRefOptions { mock?: boolean }

/**
 * The same for the everyday commands (`eval`, `check`, `compare`), which take a rubric document rather than a stored
 * version: resolves undefined when `ref` is not a rubric on a server, so the caller reads it the way it always has.
 */
export async function serverRubric(ref: string, o: RubricRefOptions, deps: HubDependencies = hubDefaults): Promise<Rubric | undefined> {
  const named = serverRef(ref, o);
  if (!named) return undefined;
  const store = deps.engine().store;
  const fetched = await fetchServerVersion(deps, hasVersions(store) ? store : undefined, named, o);
  deps.warn(fetched.said);
  return o.mock ? mockify(fetched.version.rubric) : fetched.version.rubric;
}
