import type { Evaluation } from "@verdict-ai/core";

type SummaryEvaluation = Pick<Evaluation, "id" | "status" | "job" | "aggregate" | "criteria" | "pendingTasks" | "error" | "usage">;

export function summarize(e: SummaryEvaluation) {
  return {
    id: e.id,
    status: e.status,
    ...(e.job ? { job: e.job } : {}),
    score: e.aggregate?.score,
    grade: e.aggregate?.grade,
    passed: e.aggregate?.passed,
    partial: e.aggregate?.partial,
    criteria: e.criteria?.map((c) => ({ id: c.criterionId, name: c.name, status: c.status, choice: c.choice, score: c.score, normalized: c.normalized, pending: c.pending, confidence: c.ratings?.find((r) => typeof r.confidence === "number")?.confidence, probabilities: c.ratings?.find((r) => r.probabilities)?.probabilities, rationale: c.ratings?.find((r) => r.rationale)?.rationale, quotes: c.ratings?.flatMap((r) => r.quotes ?? []).slice(0, 3) })),
    pendingTasks: e.pendingTasks,
    error: e.error,
    usage: e.usage,
  };
}

