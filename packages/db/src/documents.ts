/**
 * Translates stored documents and evaluations into database projections.
 * Document JSON remains authoritative; indexed rows derive from the same evaluation snapshot.
 */
import type { Evaluation, StoredRubric } from "@verdict-ai/core";

/** Documents originate in core and are stored intact; Drizzle's JSON column is deliberately schema agnostic. */
export function readDocument<T extends Evaluation | StoredRubric>(doc: unknown): T {
  return doc as T;
}

/** Derives indexed evaluation columns from the authoritative document; performs no I/O. */
export function evaluationRow(e: Evaluation) {
  return {
    id: e.id,
    tenantId: e.tenantId ?? null,
    rubricId: e.rubricId ?? null,
    rubricName: e.rubric.name,
    subjectName: e.subject.name ?? null,
    status: e.status,
    score: e.aggregate.score ?? null,
    grade: e.aggregate.grade ?? null,
    passed: e.aggregate.passed ?? null,
    pendingHuman: e.pendingTasks.length,
    decisionCalls: e.usage.decisionCalls,
    llmCalls: e.usage.llmCalls,
    inputTokens: e.usage.inputTokens,
    durationMs: e.usage.durationMs,
    doc: { ...e },
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Derives analytics rows from criterion ratings; performs no I/O. */
export function ratingRows(e: Evaluation) {
  return e.criteria.flatMap(c => c.ratings.map(r => ({
    id: r.id,
    evaluationId: e.id,
    tenantId: e.tenantId ?? null,
    rubricId: e.rubricId ?? null,
    criterionId: c.criterionId,
    raterId: r.raterId,
    judgeType: r.judgeType,
    status: r.status,
    score: r.score ?? null,
    normalized: r.normalized ?? null,
    confidence: r.confidence ?? null,
    model: (r.raw && "model" in r.raw ? r.raw.model : undefined) ?? null,
    createdAt: r.createdAt,
  })));
}
