/**
 * Registers `verdict push`, `verdict promote` and `verdict rollback` (docs/design/control-plane.md §8.2, §8.3).
 * `push` uploads a version; given a rubric file it freezes it and records that in verdict.lock first, so a file can be
 * shared with one command (C27). `promote` makes an environment run a version: it uploads the version if needed,
 * shows what would change, asks, and names the versions it saw so a concurrent change is refused instead of
 * overwritten. `rollback` undoes a pointer's latest change.
 */
import { CONTROL_NAME, ValidationError, type RubricVersion } from "@verdict-ai/core";
import { Command } from "commander";

import { rubricNameFor } from "../control/names.js";
import { applyChanges, describeChange, planChanges, pointerRefusal, pointersOf, type Change, type Wanted } from "../control/pointers.js";
import { addTargetOptions, asking, confirmed, controlTarget, type ControlTarget, type TargetOptions } from "../control/target.js";
import { hubDefaults, type HubDependencies } from "../hub/deps.js";
import { lockFrozen, lockKey, readLock, updateLock } from "../versions/lock.js";
import { isRubricFile, resolveVersion, workspace, type Workspace } from "../versions/workspace.js";

interface PushOptions extends TargetOptions { name?: string; lock?: string; json?: boolean }
interface PromoteOptions extends PushOptions { env: string; from?: string; note?: string; yes?: boolean }

const targetOptions = (command: Command) => addTargetOptions(command);

/** Writes the name a rubric file is kept under into its lock entry, so later commands and CI use the same name. */
async function recordName(ws: Workspace, file: string | undefined, name: string, explicit: boolean): Promise<void> {
  if (!file) return;
  const entry = (await readLock(ws.deps.lockIo, ws.lockPath)).rubrics[lockKey(ws.lockPath, file)];
  if (entry?.name === name) return;
  // An entry without a version would fail `verdict version verify`; only a frozen file can carry its name.
  if (!entry?.version) { if (explicit) ws.deps.warn(`${file} is not in ${ws.lockPath}, so the name ${name} is not recorded; \`verdict version freeze ${file}\` first, or pass --name each time`); return; }
  await updateLock(ws.deps.lockIo, ws.lockPath, file, ({ name: _previous, ...rest }) => ({ name, ...rest }));
}

/** A reference as something to run: a rubric file frozen here, or a version id this machine may or may not hold. */
async function wantedFrom(ws: Workspace, ref: string, name: string | undefined, mustBeLocked: boolean): Promise<Wanted> {
  if (isRubricFile(ref)) {
    const { version } = await resolveVersion(ws, ref);
    if (mustBeLocked) await requireLocked(ws, ref, version);
    return { name: await rubricNameFor(ws, name, [{ version, file: ref }]), versionId: version.id, version, file: ref };
  }
  if (!/^rv_[0-9a-f]{20}$/.test(ref)) throw new ValidationError(`${ref}: expected a rubric file (.yaml, .json) or a version id (rv_…)`);
  const version = await ws.store.getRubricVersion(ref);
  if (version) return { name: await rubricNameFor(ws, name, [{ version }]), versionId: ref, version };
  // Not on this machine: it can still be promoted if the server holds it, but then the name has to be said.
  if (!name) throw new ValidationError(`${ref} is not in this data directory; pass --name <name> to use the version the server keeps under that name`);
  return { name: await rubricNameFor(ws, name, []), versionId: ref };
}

/** What is promoted from a file is what the lock says was tested (C19). */
async function requireLocked(ws: Workspace, file: string, version: RubricVersion): Promise<void> {
  const locked = (await readLock(ws.deps.lockIo, ws.lockPath)).rubrics[lockKey(ws.lockPath, file)]?.version;
  if (locked === version.id) return;
  throw new ValidationError(`${file} freezes to ${version.id}, but ${ws.lockPath} ${locked ? `locks ${locked}` : "does not list it"}; run \`verdict version freeze ${file}\` (and its tests) before promoting`);
}

/** The versions another environment runs, all of them or the named rubrics. */
async function wantedFromEnvironment(target: ControlTarget, from: string, names: string[]): Promise<Wanted[]> {
  const pointers = await pointersOf(target, from);
  const missing = names.filter((n) => !pointers.has(n));
  if (missing.length) throw new ValidationError(`${from} does not run ${missing.join(", ")}`);
  if (!pointers.size) throw new ValidationError(`${from} runs nothing yet`);
  return [...pointers].filter(([name]) => !names.length || names.includes(name)).map(([name, versionId]) => ({ name, versionId }));
}

/** Promoting a version nobody reported a run of is allowed, and said out loud. */
async function warnUnreported(deps: HubDependencies, target: ControlTarget, changes: Change[]): Promise<void> {
  for (const c of changes) {
    if (!c.versionId) continue;
    const versionId = c.versionId;
    const { data } = await asking(target, (client) => client.reports.runs(target.project, { name: c.name, versionId, limit: 1 }));
    if (!data.length) deps.warn(`no run of ${c.name} at ${versionId} has been reported to ${target.project}; \`verdict run … --report\` shows the team what was tested`);
  }
}

/** Registers push, promote and rollback; failures reach the CLI failure handler. */
export function registerPromote(program: Command, deps: HubDependencies = hubDefaults) {
  targetOptions(program.command("push <ref>").description("upload a rubric version to a project: a rubric file (frozen and recorded in verdict.lock first) or rv_…"))
    .option("--name <name>", "name services ask for this rubric by (default: verdict.lock, the rubric's id, its file name)").option("--lock <path>", "lock file", "verdict.lock").option("--json")
    .action(async (ref: string, o: PushOptions) => {
      const ws = workspace(deps, o, true);
      const target = await controlTarget(deps, o);
      const wanted = await wantedFrom(ws, ref, o.name, false);
      const v = wanted.version;
      if (!v) throw new ValidationError(`${ref} is not in this data directory; there is nothing to upload`);
      const result = await asking(target, (client) => client.versions.push(target.project, wanted.name, { id: v.id, rubric: v.rubric, ...(v.parentVersionId ? { parentVersionId: v.parentVersionId } : {}), ...(v.fork ? { fork: v.fork } : {}) }));
      // What was uploaded is what the file is from now on: the lock says so, as `verdict version freeze` would have.
      if (wanted.file) await lockFrozen(ws.deps.lockIo, ws.lockPath, wanted.file, v);
      await recordName(ws, wanted.file, wanted.name, o.name !== undefined);
      if (o.json) { deps.out(JSON.stringify(result, null, 2)); return; }
      deps.out(`${result.created ? "pushed" : "already there:"} ${wanted.name} at ${v.id} ${result.created ? "to" : "in"} ${target.project} on ${target.server}`);
    });

  registerPromotion(program, deps);
  registerRollback(program, deps);
}

function registerPromotion(program: Command, deps: HubDependencies) {
  targetOptions(program.command("promote [refs...]").description("make an environment run rubric versions: files or rv_… ids, or with --from the rubric names to copy"))
    .requiredOption("--env <name>", "environment to change").option("--from <environment>", "promote what another environment runs (all of it, or the named rubrics)")
    .option("--name <name>", "name of the rubric on the server (one reference only)").option("--note <text>", "why (kept in the history)")
    .option("-y, --yes", "apply without asking").option("--lock <path>", "lock file", "verdict.lock").option("--json")
    .action(async (refs: string[], o: PromoteOptions) => {
      if (o.name && (o.from || refs.length !== 1)) throw new ValidationError("--name goes with exactly one file or version");
      if (!o.from && !refs.length) throw new ValidationError("name a rubric file or version to promote, or pass --from <environment>");
      const ws = workspace(deps, o, true);
      const target = await controlTarget(deps, o);
      const wanted = o.from ? await wantedFromEnvironment(target, o.from, refs.map((r) => named(r))) : await Promise.all(refs.map((ref) => wantedFrom(ws, ref, o.name, true)));
      const changes = planChanges(deps, o.env, wanted, await pointersOf(target, o.env));
      await warnUnreported(deps, target, changes);
      const done = await applyChanges(deps, target, changes, o);
      for (const c of done) await recordName(ws, c.file, c.name, o.name !== undefined);
      if (done.length && !o.json) deps.out(`promoted ${done.map((c) => `${c.name} to ${c.versionId}`).join(", ")} in ${o.env}`);
    });
}

function named(name: string): string {
  if (!CONTROL_NAME.test(name)) throw new ValidationError(`${name}: with --from, name rubrics (lowercase letters, digits and dashes), not files`);
  return name;
}

function registerRollback(program: Command, deps: HubDependencies) {
  targetOptions(program.command("rollback <rubric>").description("undo the latest change of a rubric's pointer in an environment"))
    .requiredOption("--env <name>", "environment to change").option("--note <text>", "why (kept in the history)").option("-y, --yes", "apply without asking").option("--json")
    .action(async (rubric: string, o: TargetOptions & { env: string; note?: string; yes?: boolean; json?: boolean }) => {
      const target = await controlTarget(deps, o);
      const expected = (await pointersOf(target, o.env)).get(rubric) ?? null;
      const { data: [latest] } = await asking(target, (client) => client.projects.history(target.project, { environment: o.env, name: rubric, limit: 1 }));
      deps.out(`${o.env} in ${target.project} on ${target.server}:`);
      // The server decides what a rollback returns to; this is what its history says that will be.
      deps.out(latest && latest.to === expected ? `${describeChange({ name: rubric, versionId: latest.from, expected })}  (undoes the ${latest.kind} of ${latest.at})` : `  ${rubric}: ${expected ?? "(none)"} → the version before its latest change`);
      if (!(await confirmed(deps, o.yes, `Roll ${rubric} back in ${o.env}?`))) { deps.out("nothing changed"); return; }
      const request = { name: rubric, expected, ...(o.note ? { note: o.note } : {}) };
      const result = await asking(target, (client) => client.environments.rollback(target.project, o.env, request)).catch((e: unknown) => { throw pointerRefusal(o.env, e); });
      if (o.json) { deps.out(JSON.stringify(result, null, 2)); return; }
      deps.out(`rolled back ${rubric} in ${o.env}: ${result.event.from ?? "(none)"} → ${result.event.to ?? "(removed)"}`);
    });
}
