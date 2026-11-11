/**
 * Changing what an environment runs (docs/design/control-plane.md §5, §8.3): read where the pointers are, show what
 * would change, ask, then send the change naming the versions that were shown. If someone else moved a pointer in
 * between, the server applies nothing and this says where the pointer is now.
 */
import { CONTROL_MAX_CHANGES, ValidationError, type RubricVersion } from "@verdict-ai/core";
import { VerdictError } from "@verdict-ai/sdk";

import type { HubDependencies } from "../hub/deps.js";
import { asking, confirmed, type ControlTarget } from "./target.js";

/** A rubric and the version an environment should run; `version` is set when this machine has the document to upload. */
export interface Wanted { name: string; versionId: string | null; version?: RubricVersion; file?: string }
export interface Change extends Wanted { expected: string | null }

export interface ChangeOptions { env: string; note?: string; yes?: boolean; json?: boolean }

const shown = (id: string | null) => id ?? "(none)";
export const describeChange = (c: Pick<Change, "name" | "versionId" | "expected">) => `  ${c.name}: ${shown(c.expected)} → ${c.versionId ?? "(removed)"}`;

/** Which version of each rubric an environment runs now. */
export async function pointersOf(target: ControlTarget, environment: string): Promise<Map<string, string>> {
  const { pointers } = await asking(target, (client) => client.environments.get(target.project, environment));
  return new Map(pointers.map((p) => [p.name, p.versionId]));
}

/** Drops what is already in place (saying so) and pairs the rest with the version each pointer is at now. */
export function planChanges(deps: HubDependencies, environment: string, wanted: Wanted[], pointers: Map<string, string>): Change[] {
  const duplicate = wanted.find((w, i) => wanted.findIndex((x) => x.name === w.name) !== i);
  if (duplicate) throw new ValidationError(`${duplicate.name} is named twice; an environment runs one version of a rubric`);
  const changes: Change[] = [];
  for (const w of wanted) {
    const expected = pointers.get(w.name) ?? null;
    if (expected === w.versionId) deps.out(w.versionId ? `${w.name} is already at ${w.versionId} in ${environment}` : `${w.name} has no pointer in ${environment}`);
    else changes.push({ ...w, expected });
  }
  if (changes.length > CONTROL_MAX_CHANGES) throw new ValidationError(`${changes.length} rubrics would change; one promotion changes at most ${CONTROL_MAX_CHANGES}, so name fewer at a time`);
  return changes;
}

/** A refused change in words: where the pointers are now, or the server's own reason. */
function refusal(environment: string, e: unknown): unknown {
  if (!(e instanceof VerdictError) || e.type !== "pointer_conflict") return e;
  const current = (e.details?.current ?? []) as Array<{ name: string; versionId: string | null }>;
  const now = current.map((c) => `${c.name} is at ${shown(c.versionId)}`).join(", ");
  return new ValidationError(`${environment} changed since it was read${now ? `: ${now}` : ""}. Nothing was applied; run the command again`);
}

/**
 * Shows the changes, asks, uploads the versions this machine has, and applies all changes or none. Resolves to the
 * changes that were applied (none when the answer was no).
 */
export async function applyChanges(deps: HubDependencies, target: ControlTarget, changes: Change[], o: ChangeOptions): Promise<Change[]> {
  if (!changes.length) return [];
  deps.out(`${o.env} in ${target.project} on ${target.server}:`);
  for (const c of changes) deps.out(describeChange(c));
  if (!(await confirmed(deps, o.yes, `Apply to ${o.env}?`))) { deps.out("nothing changed"); return []; }
  for (const c of changes) {
    const v = c.version;
    if (v) await asking(target, (client) => client.versions.push(target.project, c.name, { id: v.id, rubric: v.rubric, ...(v.parentVersionId ? { parentVersionId: v.parentVersionId } : {}), ...(v.fork ? { fork: v.fork } : {}) }));
  }
  const request = { changes: changes.map((c) => ({ name: c.name, versionId: c.versionId, expected: c.expected })), ...(o.note ? { note: o.note } : {}) };
  const result = await asking(target, (client) => client.environments.promote(target.project, o.env, request)).catch((e: unknown) => { throw refusal(o.env, e); });
  if (o.json) deps.out(JSON.stringify(result, null, 2));
  return changes;
}

export { refusal as pointerRefusal };
