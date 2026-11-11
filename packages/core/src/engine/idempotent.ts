/**
 * Reservations and initial documents must be visible before ingestion or any judge call starts.
 */
import type { Store, IdempotencyRecord } from "../store/index.js";
import { fingerprint } from "../idempotency.js";
import type { Evaluation } from "../schema/evaluation.js";
import { Subject } from "../schema/subject.js";

import { EngineRun } from "./run.js";
import { initialEvaluation } from "./shared.js";
import { ConflictError, ValidationError } from "./errors.js";
import { rankEvaluations } from "./ranking.js";
import { mapLimit } from "./concurrency.js";
import { type EvaluateRequest } from "./types.js";

interface EngineLocks {
  reservations: Map<string, Promise<void>>;
  jobs: Map<string, Promise<Evaluation>>;
}

// The only shared mutable registry: engines on one store must share reservation and delivery locks.
// Supplying a registry isolates tests without changing cross-engine deduplication in production.
const defaultLocks = new WeakMap<Store, EngineLocks>();
declare module "./types.js" {
  interface EngineOptions { locks?: WeakMap<Store, EngineLocks> }
}

/** Reserves requests before judging; conflicting key reuse rejects with ConflictError. */
export class EngineIdempotent extends EngineRun {
  private lockRegistry: typeof defaultLocks;

  constructor(opts: ConstructorParameters<typeof EngineRun>[0] = {}) {
    super(opts);
    this.lockRegistry = opts.locks ?? defaultLocks;
  }

  async evaluateBatch(rubricRef: EvaluateRequest["rubric"], subjects: Array<EvaluateRequest["subject"]>, opts: Omit<EvaluateRequest, "rubric" | "subject"> = {}) {
    const { rubric } = await this.resolveRubric(rubricRef, opts.tenantId);
    const batchId = opts.batchId ?? this.makeId("bat");
    const evaluations = await mapLimit(subjects, Math.max(1, Math.floor(this.concurrency / 2)), (subject) => this.evaluate({ ...opts, rubric, subject, batchId }));
    const ranking = rankEvaluations(evaluations);
    return { evaluations, ranking };
  }

  async evaluateIdempotent(req: EvaluateRequest & { idempotencyKey: string }) {
    const result = await this.runIdempotent(req, "evaluation", [req.subject]);
    return { evaluation: result.evaluations[0]!, replayed: result.replayed };
  }

  async evaluateBatchIdempotent(rubric: EvaluateRequest["rubric"], subjects: Array<EvaluateRequest["subject"]>, opts: Omit<EvaluateRequest, "rubric" | "subject"> & { idempotencyKey: string }) {
    const result = await this.runIdempotent({ ...opts, rubric, subject: {}, batchId: opts.batchId ?? this.makeId("bat") }, "batch", subjects);
    return { ...result, ranking: rankEvaluations(result.evaluations) };
  }

  protected async runIdempotent(req: EvaluateRequest & { idempotencyKey: string }, targetType: "evaluation" | "batch", subjects: Array<EvaluateRequest["subject"]>, lifecycle: { after?: (ev: Evaluation) => Promise<Evaluation>; prepare?: (ev: Evaluation) => Evaluation } = {}) {
    const locks = this.locksForStore().reservations;
    const { after, prepare = (ev: Evaluation) => ev } = lifecycle;
    if (req.idempotencyKey.length < 1 || req.idempotencyKey.length > 255) throw new ValidationError("Idempotency key must contain 1–255 characters");
    const lockKey = JSON.stringify([req.tenantId ?? "", req.idempotencyKey]);
    const { release, dispose } = await acquireReservationLock(locks, lockKey);
    try {
      const body = req.fingerprintBody ?? (targetType === "evaluation"
        ? { rubric: req.rubric, subject: req.subject, metadata: req.metadata, webhook: req.webhook }
        : { rubric: req.rubric, subjects, metadata: req.metadata, webhook: req.webhook });
      const hash = await fingerprint(body);
      const claim = await resolveReservation(
        () => this.replayIdempotent(req, hash, targetType),
        () => this.reserveRequest(req, targetType, subjects, hash, prepare),
      );
      if (claim.replayed) return { evaluations: claim.value, replayed: true };
      const { rubric, ids, initial } = claim.value;
      // why: reservation and targets are visible before another caller can replay; judging runs outside the lock.
      release();
      const evaluateSubject = (subject: EvaluateRequest["subject"], index: number) => {
        if (after) return after(initial[index]!);
        return this.evaluate({ ...req, rubric, subject, id: ids[index] });
      };
      const evaluations = await mapLimit(subjects, Math.max(1, Math.floor(this.concurrency / 2)), evaluateSubject);
      return { evaluations, replayed: false };
    } finally {
      dispose();
    }
  }
  protected locksForStore(): EngineLocks {
    const existing = this.lockRegistry.get(this.store);
    if (existing) return existing;
    const locks: EngineLocks = { reservations: new Map(), jobs: new Map() };
    this.lockRegistry.set(this.store, locks);
    return locks;
  }

  private async replayIdempotent(req: EvaluateRequest & { idempotencyKey: string }, hash: string, targetType: "evaluation" | "batch") {
    const record = await this.store.getIdempotency(req.tenantId, req.idempotencyKey);
    if (!record || !(Date.parse(record.expiresAt) > this.now())) return undefined;
    const ids = record.targetType === "evaluation" ? [record.targetId!] : record.evaluationIds!;
    const evaluations = await Promise.all(ids.map(id => this.store.getEvaluation(id, req.tenantId)));
    if (!evaluations.every((e): e is Evaluation => !!e)) return undefined;
    if (record.fingerprint !== hash || record.targetType !== targetType) throw new ConflictError("Idempotency key already used for a different request");
    return evaluations;
  }

  private async reserveRequest(req: EvaluateRequest & { idempotencyKey: string }, targetType: "evaluation" | "batch", subjects: Array<EvaluateRequest["subject"]>, hash: string, prepare: (ev: Evaluation) => Evaluation) {
    // Validate everything before reserving ids. No ingestion or judges run here.
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    subjects.forEach(subject => Subject.parse(subject));
    const ids = subjects.map(() => this.makeId("eval"));
    const recordToStore: IdempotencyRecord = {
      tenantId: req.tenantId, key: req.idempotencyKey, fingerprint: hash, targetType,
      targetId: targetType === "evaluation" ? ids[0] : undefined, evaluationIds: targetType === "batch" ? ids : undefined,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + this.idempotencyTtlMs).toISOString()
    };
    const initial = subjects.map((subject, i) => prepare(initialEvaluation({ ...req, subject, id: ids[i] }, rubric, rubricId, this.now)));
    if (this.store.reserveIdempotency) {
      if (!await this.store.reserveIdempotency(recordToStore, initial)) return undefined;
    } else {
      await this.store.putIdempotency(recordToStore);
      for (const evaluation of initial) await this.store.putEvaluation(evaluation);
    }
    return { rubric, ids, initial };
  }

}

/** Serializes reservation publication; release permits replay while judging continues. */
export async function acquireReservationLock(locks: Map<string, Promise<void>>, key: string) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  // why: register before awaiting so later callers queue behind this reservation, not its predecessor.
  locks.set(key, current);
  await previous;
  return { release, dispose() {
    release();
    // why: an older caller must not delete a newer caller's pending lock.
    if (locks.get(key) === current) locks.delete(key);
  } };
}

/** A lost cross-process reservation race retries replay before trying to reserve again. */
export async function resolveReservation<Replay, Reservation>(replay: () => Promise<Replay | undefined>, reserve: () => Promise<Reservation | undefined>): Promise<{ replayed: true; value: Replay } | { replayed: false; value: Reservation }> {
  for (;;) {
    const existing = await replay();
    if (existing !== undefined) return { replayed: true, value: existing };
    const reserved = await reserve();
    if (reserved !== undefined) return { replayed: false, value: reserved };
    // why: another process won the atomic reservation; its published targets become the next replay.
  }
}
