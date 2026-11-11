/**
 * Converts criterion units and computes rater and overall aggregates.
 * Normalized values drive comparisons; missing scores and pending humans remain explicit in partial results.
 */
import { ValidationError } from "../engine/errors.js";
import { criterionScale, scaleRange, snapToScale, normalizeScore } from "./scales.js";
import { aggregateNumbers, clamp, mean, round } from "./numbers.js";
import { computeRaw } from "./methods.js";
export { scaleRange, criterionScale, normalizeScore, denormalizeScore, snapToScale, coerceScore, scoreLabel } from "./scales.js";
export { aggregateNumbers, clamp, mean, median, round } from "./numbers.js";
import type { AggregateResult, CriterionResult, Rating } from "../schema/evaluation.js";
import type { Aggregation, Criterion, Rubric } from "../schema/rubric.js";

/* ------------------------------------------------------------------ */
/* Rater-level aggregation (many ratings -> one criterion score)        */
/* ------------------------------------------------------------------ */

/** Combines criterion ratings while retaining pending and error states; expects validated rubric data. */
export function aggregateRatings(
  rubric: Rubric,
  criterion: Criterion,
  ratings: Rating[],
  expected: number,
): CriterionResult {
  const scale = criterionScale(rubric, criterion);
  const scored = ratings.filter((r) => r.status === "scored" && (typeof r.score === "number" || (criterion.choices && r.choice !== undefined)));
  // why: errors consume expected rater slots but never contribute a score.
  const pendingCount = Math.max(0, expected - scored.length - ratings.filter((r) => r.status === "error").length);
  const method = criterion.rater ?? rubric.aggregation.rater;
  const base: CriterionResult = {
    criterionId: criterion.id,
    name: criterion.name,
    weight: criterion.weight,
    group: criterion.group,
    status: "pending",
    ratings,
    pending: pendingCount,
  };
  if (criterion.choices && scored.length) {
    applyChoices(base, criterion, scored);
    // why: categorical choices without a value mapping cannot contribute to numeric aggregation.
    if (!criterion.values) return { ...base, status: pendingCount > 0 ? "pending" : "scored" };
  }
  if (!scored.length) {
    const allErrored = ratings.length > 0 && ratings.every((r) => r.status === "error");
    return { ...base, status: !allErrored && pendingCount > 0 ? "pending" : "error" };
  }
  const score = snapToScale(aggregateNumbers(scored.map((r) => r.score!), method)!, scale);
  const normalized = normalizeScore(score, scale);
  const gate = rubric.aggregation.gates.find((g) => g.criterion === criterion.id);
  return {
    ...base,
    status: pendingCount > 0 ? "pending" : "scored",
    score,
    normalized,
    gate: gate ? evalGate(gate, score) : undefined,
  };
}

function evalGate(g: Aggregation["gates"][number], score: number) {
  const passed = (g.min === undefined || score >= g.min) && (g.max === undefined || score <= g.max);
  return { passed, message: passed ? undefined : g.message ?? `${g.criterion} outside [${g.min ?? "-inf"}, ${g.max ?? "inf"}]` };
}

/* ------------------------------------------------------------------ */
/* Overall aggregation (criteria -> one score)                          */
/* ------------------------------------------------------------------ */

/** Computes the overall result from recorded criterion scores; formula errors propagate. */
export function aggregateCriteria(rubric: Rubric, results: CriterionResult[], aggregation: Aggregation = rubric.aggregation): AggregateResult {
  const partial = results.some((r) => r.status === "pending");
  const gates = results.filter((r) => r.gate).map((r) => ({ criterion: r.criterionId, ...r.gate! }));

  const { included, excluded, failed } = selectIncluded(rubric, results, aggregation);
  if (failed) return { method: aggregation.method, range: outRange(aggregation), gates, partial, included: [], excluded, passed: false };

  const empty: AggregateResult = { method: aggregation.method, range: outRange(aggregation), gates, partial, included: included.map((r) => r.criterionId), excluded };
  if (!included.length && aggregation.method !== "formula") return empty;

  const { raw, natural } = computeRaw(rubric, results, included, aggregation);
  return finishAggregate(empty, raw, natural, aggregation);
}

function finishAggregate(empty: AggregateResult, raw: number, natural: [number, number], aggregation: Aggregation): AggregateResult {
  if (!Number.isFinite(raw)) throw new ValidationError("aggregate score must be finite");
  const gates = empty.gates;
  const range = outRange(aggregation);
  const score = range ? rescale(raw, natural, range) : raw;
  const rounded = round(score, aggregation.precision);
  const gatesPassed = gates.every((g) => g.passed);
  // why: highest qualifying grade wins regardless of the rubric declaration order.
  const grade = aggregation.grades?.length
    ? [...aggregation.grades].sort((a, b) => b.min - a.min).find((g) => rounded >= g.min)?.label
    : undefined;
  const passed =
    aggregation.passThreshold !== undefined || gates.length
      ? gatesPassed && (aggregation.passThreshold === undefined || rounded >= aggregation.passThreshold)
      : undefined;

  return { ...empty, raw: round(raw, 6), score: rounded, grade, passed };
}

function outRange(a: Aggregation): [number, number] | null { return a.normalize === false ? null : a.normalize; }
function rescale(x: number, from: [number, number], to: [number, number]) {
  // why: a constant source scale has no spread; map it to the destination minimum without dividing by zero.
  if (from[1] === from[0]) return to[0];
  return to[0] + ((clamp(x, from[0], from[1]) - from[0]) * (to[1] - to[0])) / (from[1] - from[0]);
}
function applyChoices(base: CriterionResult, criterion: Criterion, scored: Rating[]) {
  const options = Object.keys(criterion.choices!);
  const counts = options.map(o => scored.filter(r => r.choice === o).length);
  // why: declaration order breaks tied votes deterministically.
  base.choice = options[counts.indexOf(Math.max(...counts))];
  base.choices = Object.fromEntries(options.map(o => [o, mean(scored.map(r => r.probabilities?.[o] ?? (r.choice === o ? 1 : 0)))]));
}

function selectIncluded(rubric: Rubric, results: CriterionResult[], aggregation: Aggregation) {
  const byId = new Map(rubric.criteria.map(c => [c.id, c]));
  const included: CriterionResult[] = [];
  const excluded: string[] = [];
  for (const r of results) {
    const c = validateResult(byId, r);
    if (c.choices && !c.values) { excluded.push(r.criterionId); continue; }
    if (typeof r.normalized === "number") {
      if (c.weight === 0) excluded.push(r.criterionId); else included.push(r);
      continue;
    }
    if (c.optional || aggregation.missing === "exclude") { excluded.push(r.criterionId); continue; }
    if (aggregation.missing === "zero") { included.push({ ...r, normalized: 0, score: scaleRange(criterionScale(rubric, c))[0] }); continue; }
    // why: missing=fail rejects the whole aggregate rather than silently changing its denominator.
    return { included: [], excluded: results.map(x => x.criterionId), failed: true };
  }

  return { included, excluded, failed: false };

}

function validateResult(criteria: Map<string, Criterion>, result: CriterionResult): Criterion {
  const criterion = criteria.get(result.criterionId);
  if (!criterion) throw new ValidationError(`unknown criterion: ${result.criterionId}`);
  if (result.normalized !== undefined && !Number.isFinite(result.normalized)) {
    throw new ValidationError(`nonfinite score for criterion: ${result.criterionId}`);
  }
  return criterion;
}
