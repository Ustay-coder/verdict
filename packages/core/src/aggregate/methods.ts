import { evaluateExpression } from "../expr.js";
import { ValidationError } from "../engine/errors.js";
import type { CriterionResult } from "../schema/evaluation.js";
import type { Aggregation, Criterion, Rubric } from "../schema/rubric.js";
import { mean, median } from "./numbers.js";
import { criterionScale, scaleRange } from "./scales.js";

type RawResult = { raw: number; natural: [number, number] };
type RawContext = {
  rubric: Rubric; results: CriterionResult[]; included: CriterionResult[]; aggregation: Aggregation;
  byId: Map<string, Criterion>; n: number[]; w: number[]; wsum: number;
};
// why: geometric aggregation floors zero to keep log finite while retaining a near-zero contribution.
const GEOMETRIC_FLOOR = 1e-9;
const rawMethods: Record<Aggregation["method"], (ctx: RawContext) => RawResult> = {
  weighted_mean: ({ n, w, wsum }) => ({ raw: n.reduce((s, x, i) => s + x * w[i]!, 0) / wsum, natural: [0, 1] }),
  mean: ({ n }) => ({ raw: mean(n), natural: [0, 1] }),
  median: ({ n }) => ({ raw: median([...n].sort((a, b) => a - b)), natural: [0, 1] }),
  min: ({ n }) => ({ raw: Math.min(...n), natural: [0, 1] }),
  max: ({ n }) => ({ raw: Math.max(...n), natural: [0, 1] }),
  geometric_mean: ({ n, w, wsum }) => ({ raw: Math.exp(n.reduce((s, x, i) => s + (w[i]! / wsum) * Math.log(Math.max(x, GEOMETRIC_FLOOR)), 0)), natural: [0, 1] }),
  weighted_sum,
  formula,
};
export function computeRaw(rubric: Rubric, results: CriterionResult[], included: CriterionResult[], aggregation: Aggregation): RawResult {
  const byId = new Map(rubric.criteria.map(c => [c.id, c]));
  const n = included.map((r) => r.normalized!);
  const w = included.map((r) => byId.get(r.criterionId)!.weight);
  const wsum = w.reduce((a, b) => a + b, 0);
  if (included.length && (!Number.isFinite(wsum) || wsum <= 0)) throw new ValidationError("total criterion weight must be positive and finite");

  // Natural ranges preserve raw scale units when normalization is disabled.
  if (!Object.hasOwn(rawMethods, aggregation.method)) throw new ValidationError(`unknown aggregation method: ${aggregation.method}`);
  return rawMethods[aggregation.method]({ rubric, results, included, aggregation, byId, n, w, wsum });
}
function weighted_sum(ctx: RawContext): RawResult {
  const { rubric, included, byId } = ctx;

  // why: weighted sums preserve criterion units; their output range must include weighted minima as well as maxima.
  const raw = included.reduce((s, r) => s + r.score! * byId.get(r.criterionId)!.weight, 0);
  const lo = included.reduce((s, r) => s + scaleRange(criterionScale(rubric, byId.get(r.criterionId)!))[0] * byId.get(r.criterionId)!.weight, 0);
  const hi = included.reduce((s, r) => s + scaleRange(criterionScale(rubric, byId.get(r.criterionId)!))[1] * byId.get(r.criterionId)!.weight, 0);
  const natural: [number, number] = [lo, hi];
  return { raw, natural };

}

function formula(ctx: RawContext): RawResult {
  const { rubric, results, aggregation, byId } = ctx;

  const scope: Record<string, number> = {};
  for (const r of results) {
    const c = byId.get(r.criterionId)!;
    const has = typeof r.normalized === "number";
    // why: absent criteria expose the scale minimum and a separate presence flag so formulas can choose their missing policy.
    scope[c.id] = has ? r.score! : scaleRange(criterionScale(rubric, c))[0];
    scope[`${c.id}_n`] = has ? r.normalized! : 0;
    scope[`${c.id}_w`] = c.weight;
    scope[`${c.id}_present`] = has ? 1 : 0;
    for (const option of Object.keys(c.choices ?? {})) {
      scope[`${c.id}_${option}`] = r.choice === option ? 1 : 0;
      scope[`${c.id}_p_${option}`] = r.choices?.[option] ?? 0;
    }
  }
  const raw = evaluateExpression(aggregation.formula!, scope);
  // A formula is assumed to yield 0..1 unless it is obviously on a wider range.
  const natural: [number, number] = raw >= 0 && raw <= 1 ? [0, 1] : [0, 100];
  return { raw, natural };

}
