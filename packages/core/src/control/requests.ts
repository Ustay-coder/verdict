/**
 * Request shapes of the control plane and the documents built from them. The schemas are what REST accepts; the
 * builders turn a validated request into what a store keeps, so every surface applies the same rules.
 */
import { z } from "zod";
import { ValidationError } from "../engine/errors.js";
import { CHANGE_KINDS, freezeRubric } from "../versions/rubric-version.js";
import { CONTROL_MAX_CHANGES, type ControlStore } from "./store.js";
import { CONTROL_NAME, type Actor, type ProjectScope, type ProjectVersion, type PromotionEvent } from "./types.js";

export const CONTROL_NOTE_MAX = 2000;
/** A version upload may be at most this many bytes. */
export const CONTROL_VERSION_BYTES = 1_000_000;

const name = z.string().regex(CONTROL_NAME, "use lowercase letters, digits and dashes (up to 63 characters, not starting with a dash)");
const versionId = z.string().regex(/^rv_[0-9a-f]{20}$/, "expected a version id (rv_…)");
const note = z.string().max(CONTROL_NOTE_MAX).optional();

/** Creates a project or an environment. */
export const NameRequest = z.object({ name });
/** Deletes a project or an environment: the caller repeats its name. */
export const ConfirmRequest = z.object({ confirm: z.string() });

export const VersionUpload = z.object({
  /** The id the client froze the rubric to; the server freezes it again and refuses a mismatch. */
  id: versionId,
  rubric: z.unknown(),
  parentVersionId: versionId.optional(),
  fork: z.object({ note, changeKinds: z.array(z.enum(CHANGE_KINDS)) }).optional(),
});
export type VersionUpload = z.infer<typeof VersionUpload>;

const change = z.object({
  name,
  /** The version to point at; null removes the pointer. */
  versionId: versionId.nullable(),
  /** The version the caller saw the pointer at; null when it saw none. */
  expected: versionId.nullable(),
});
export const PromotionRequest = z.object({ changes: z.array(change).min(1).max(CONTROL_MAX_CHANGES), note });
export type PromotionRequest = z.infer<typeof PromotionRequest>;

export const RollbackRequest = z.object({ name, expected: versionId.nullable(), note });
export type RollbackRequest = z.infer<typeof RollbackRequest>;

/** Parses a name taken from a URL; throws ValidationError naming what it is. */
export function controlName(value: string, what: string): string {
  if (!CONTROL_NAME.test(value)) throw new ValidationError(`${what} name "${value}": use lowercase letters, digits and dashes (up to 63 characters, not starting with a dash)`);
  return value;
}

/** Freezes an uploaded rubric again and keeps it under `name`; throws when it does not freeze to the id the client sent. */
export async function projectVersion(upload: VersionUpload, scope: ProjectScope, rubricName: string, now: () => number): Promise<ProjectVersion> {
  // why: rubric validators throw plain errors; an invalid upload is the caller's mistake, not a server failure.
  const frozen = await freezeRubric(upload.rubric, { tenantId: scope.tenantId, now }).catch((e: unknown) => { throw new ValidationError(e instanceof Error ? e.message : String(e)); });
  if (frozen.id !== upload.id) throw new ValidationError(`the rubric freezes to ${frozen.id}, not ${upload.id}`);
  return {
    ...frozen, project: scope.project, name: rubricName,
    ...(upload.parentVersionId ? { parentVersionId: upload.parentVersionId } : {}),
    ...(upload.fork ? { fork: { ...(upload.fork.note ? { note: upload.fork.note } : {}), changeKinds: upload.fork.changeKinds } } : {}),
  };
}

/** Where and when pointer changes happen, and who makes them. */
export interface PromotionContext { scope: ProjectScope; environment: string; actor?: Actor; at: string; id?: () => string }

const eventId = () => `prm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

function eventOf(ctx: PromotionContext, rest: Pick<PromotionEvent, "name" | "from" | "to" | "kind">, text: string | undefined): PromotionEvent {
  return {
    ...(ctx.scope.tenantId === undefined ? {} : { tenantId: ctx.scope.tenantId }), project: ctx.scope.project,
    id: (ctx.id ?? eventId)(), environment: ctx.environment, ...rest,
    ...(text ? { note: text } : {}), ...(ctx.actor ? { actor: ctx.actor } : {}), at: ctx.at,
  };
}

/** The history events a promotion request asks for. Throws on a change that would change nothing. */
export function promotionEvents(request: PromotionRequest, ctx: PromotionContext): PromotionEvent[] {
  return request.changes.map((c) => {
    if (c.versionId === null && c.expected === null) throw new ValidationError(`${c.name}: there is no pointer to remove`);
    if (c.versionId === c.expected) throw new ValidationError(`${c.name} is already at ${c.versionId}`);
    return eventOf(ctx, { name: c.name, from: c.expected, to: c.versionId, kind: c.versionId === null ? "unset" : "promote" }, request.note);
  });
}

export type RollbackPlan =
  | { ok: true; event: PromotionEvent }
  /** `pointer_conflict`: the pointer is not where the caller saw it. `nothing_to_roll_back`: no earlier version is on record. */
  | { ok: false; reason: "no_environment" | "pointer_conflict" | "nothing_to_roll_back"; current: string | null };

/**
 * Undoes the latest change of one pointer: the event that would put it back where that change found it. Rolling back
 * twice returns to where it started. The first promotion has nothing before it, so it cannot be rolled back.
 */
export async function planRollback(store: ControlStore, request: RollbackRequest, ctx: PromotionContext): Promise<RollbackPlan> {
  const environment = await store.getEnvironment(ctx.scope, ctx.environment);
  if (!environment) return { ok: false, reason: "no_environment", current: null };
  const pointers = await store.listPointers(ctx.scope, ctx.environment);
  const current = pointers.find((p) => p.name === request.name)?.versionId ?? null;
  if (current !== request.expected) return { ok: false, reason: "pointer_conflict", current };
  const [latest] = await store.listHistory(ctx.scope, { environment: ctx.environment, name: request.name, limit: 1 });
  // History of an environment that was deleted and made again does not describe the pointer that is there now.
  const describesPointer = latest && latest.to === current && latest.at >= environment.createdAt;
  if (!describesPointer || latest.from === null) return { ok: false, reason: "nothing_to_roll_back", current };
  return { ok: true, event: eventOf(ctx, { name: request.name, from: current, to: latest.from, kind: "rollback" }, request.note) };
}
