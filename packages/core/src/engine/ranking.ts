import type { Evaluation } from "../schema/evaluation.js";

/** Ranks scored evaluations descending and leaves missing scores last; does not mutate inputs. */
export function rankEvaluations(evaluations: Evaluation[]) {
  return evaluations
    .map((e, i) => ({ rank: 0, evaluationId: e.id, subject: e.subject.name ?? e.subject.id ?? `#${i + 1}`, score: e.aggregate.score, grade: e.aggregate.grade, passed: e.aggregate.passed, status: e.status }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
