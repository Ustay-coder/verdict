/**
 * The lock check on everyday commands (`eval`, `check`, `compare`): when a rubric file is listed in verdict.lock,
 * make sure what runs is what was locked (docs/design/hub.md X1, V08).
 *   - before: the file must still freeze to its locked version — else warn, or with --strict stop before any judge;
 *   - after: the questions sent and the models that answered must match the run recorded for that version — a
 *     changed question format or an alias that now resolves to another model shows up here.
 * Files that are not in the lock, stored rubric ids and --mock runs (deliberately other versions) are not checked.
 */
import { freezeRubric, loadRubricText, sentFingerprint, ValidationError, type Evaluation, type RunModel } from "@verdict-ai/core";

import { lockKey, readLock, type LockEntry, type LockIo } from "./lock.js";
import { isRubricFile, versionDefaults } from "./workspace.js";

export interface GuardIo { lockIo: LockIo; readText: (path: string) => Promise<string>; warn: (line: string) => void }
export const guardDefaults: GuardIo = { lockIo: versionDefaults.lockIo, readText: versionDefaults.readText, warn: versionDefaults.warn };

export interface GuardOptions { lock?: string; strict?: boolean; mock?: boolean }

export interface LockGuard {
  /** Checks what the finished evaluations sent; throws with --strict when it differs from the lock. */
  after(evaluations: Array<Pick<Evaluation, "criteria">>): Promise<void>;
}

const NOOP: LockGuard = { after: async () => {} };

/** Checks `ref` against the lock before anything runs; resolves a guard for the evaluations that follow. */
export async function guardRubric(ref: string, opts: GuardOptions, io: GuardIo = guardDefaults): Promise<LockGuard> {
  if (opts.mock || !isRubricFile(ref)) return NOOP;
  const lockPath = opts.lock ?? "verdict.lock";
  const entry = (await readLock(io.lockIo, lockPath)).rubrics[lockKey(lockPath, ref)];
  if (!entry?.version) return NOOP;
  const current = await freezeRubric(loadRubricText(await io.readText(ref)));
  if (current.id !== entry.version) {
    report(io, opts, `${ref} changed since it was locked (locked ${entry.version}, now ${current.id}); review the change and run \`verdict version freeze ${ref}\``);
    return NOOP;
  }
  return { after: (evaluations) => checkSent(io, opts, ref, entry, evaluations) };
}

async function checkSent(io: GuardIo, opts: GuardOptions, ref: string, entry: LockEntry, evaluations: Array<Pick<Evaluation, "criteria">>): Promise<void> {
  const verified = entry.verified;
  if (!verified) return;
  const sent = await sentFingerprint(evaluations);
  const problems: string[] = [];
  if (sent.questionsHash && verified.questionsHash && sent.questionsHash !== verified.questionsHash) {
    problems.push(`the questions sent differ from those of ${verified.runId} (Verdict's question format changed?)`);
  }
  const was = resolved(verified.models), now = resolved(sent.models);
  if (now.length && was.length && now.join() !== was.join()) problems.push(`the answering model changed: ${was.join(", ")} → ${now.join(", ")}`);
  if (problems.length) report(io, opts, `${ref} is locked at ${entry.version}, but ${problems.join("; ")}; re-verify with \`verdict run -r ${ref} -d <cases>\``);
}

// Only models the provider named can be compared; an unverified alias says nothing about what answered.
const resolved = (models: RunModel[]) => models.filter((m) => m.verified && m.resolved).map((m) => `${m.provider}/${m.resolved}`).sort();

function report(io: GuardIo, opts: GuardOptions, message: string): void {
  if (opts.strict) throw new ValidationError(`verdict.lock: ${message}`);
  io.warn(`warning: verdict.lock: ${message}`);
}
