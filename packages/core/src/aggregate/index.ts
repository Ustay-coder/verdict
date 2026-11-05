import type { Aggregation, Criterion, RaterAggregation, Rubric, Scale } from "../schema/rubric.js";
import type { AggregateResult, CriterionResult, Rating } from "../schema/evaluation.js";
import { evaluateExpression } from "../expr.js";

/* ------------------------------------------------------------------ */
/* Scales                                                              */
/* ------------------------------------------------------------------ */

export function scaleRange(scale: Scale): [number, number] {
  switch (scale.type) {
    case "numeric": return [scale.min, scale.max];
    case "binary": return [0, 1];
    case "ordinal": {
      const vals = scale.values ?? scale.labels.map((_, i) => i);
      return [Math.min(...vals), Math.max(...vals)];
    }
  }
}

export function criterionScale(rubric: Rubric, c: Criterion): Scale {
  return c.scale ?? rubric.scale;
}

/** Map a raw score on `scale` to 0..1. */
export function normalizeScore(score: number, scale: Scale): number {
  const [lo, hi] = scaleRange(scale);
  if (hi === lo) return score >= hi ? 1 : 0;
  return clamp((score - lo) / (hi - lo), 0, 1);
}

/** Map 0..1 to a raw score on `scale`, honoring step / ordinal values. */
export function denormalizeScore(n: number, scale: Scale): number {
  const [lo, hi] = scaleRange(scale);
  const v = lo + clamp(n, 0, 1) * (hi - lo);
  return snapToScale(v, scale);
}

/** Snap a raw score onto the scale (step, ordinal values, binary). */
export function snapToScale(v: number, scale: Scale): number {
  const [lo, hi] = scaleRange(scale);
  v = clamp(v, lo, hi);
  if (scale.type === "binary") return v >= 0.5 ? 1 : 0;
  if (scale.type === "ordinal") {
    const vals = scale.values ?? scale.labels.map((_, i) => i);
    return vals.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), vals[0]!);
  }
  if (scale.step) return round(lo + Math.round((v - lo) / scale.step) * scale.step, 6);
  return round(v, 3);
}

/** Resolve a human / string score (label or number) to a raw numeric score. */
export function coerceScore(input: number | string, scale: Scale): number {
  if (typeof input === "number") return snapToScale(input, scale);
  const s = input.trim().toLowerCase();
  if (scale.type === "ordinal") {
    const i = scale.labels.findIndex((l) => l.toLowerCase() === s);
    if (i >= 0) return (scale.values ?? scale.labels.map((_, k) => k))[i]!;
  }
  if (scale.type === "binary" && scale.labels) {
    const i = scale.labels.findIndex((l) => l.toLowerCase() === s);
    if (i >= 0) return i;
  }
  if (["pass", "yes", "true"].includes(s)) return scaleRange(scale)[1];
  if (["fail", "no", "false"].includes(s)) return scaleRange(scale)[0];
  const n = Number(s);
  if (Number.isFinite(n)) return snapToScale(n, scale);
  throw new Error(`cannot interpret score "${input}" on scale ${scale.type}`);
}

export function scoreLabel(score: number, scale: Scale): string | undefined {
  if (scale.type === "ordinal") {
    const vals = scale.values ?? scale.labels.map((_, i) => i);
    const i = vals.indexOf(score);
    return i >= 0 ? scale.labels[i] : undefined;
  }
  if (scale.type === "binary" && scale.labels) return scale.labels[score >= 0.5 ? 1 : 0];
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Rater-level aggregation (many ratings -> one criterion score)        */
/* ------------------------------------------------------------------ */

export function aggregateNumbers(values: number[], method: RaterAggregation | "mean"): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  switch (method) {
    case "mean": return mean(values);
    case "median": return median(sorted);
    case "trimmed_mean": {
      if (sorted.length < 3) return mean(sorted);
      const k = Math.floor(sorted.length * 0.1) || 1;
      return mean(sorted.slice(k, sorted.length - k));
    }
    case "min": return sorted[0];
    case "max": return sorted[sorted.length - 1];
    case "majority": {
      const counts = new Map<number, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      let best = sorted[0]!, bestN = 0;
      for (const [v, n] of counts) if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
      return best;
    }
  }
}

export function aggregateRatings(
  rubric: Rubric,
  criterion: Criterion,
  ratings: Rating[],
  expected: number,
): CriterionResult {
  const scale = criterionScale(rubric, criterion);
  const scored = ratings.filter((r) => r.status === "scored" && typeof r.score === "number");
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
  if (!scored.length) {
    const allErrored = ratings.length > 0 && ratings.every((r) => r.status === "error");
    return { ...base, status: allErrored ? "error" : pendingCount > 0 ? "pending" : "error" };
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

export function aggregateCriteria(rubric: Rubric, results: CriterionResult[], aggregation: Aggregation = rubric.aggregation): AggregateResult {
  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  const scored = results.filter((r) => (r.status === "scored" || r.status === "pending") && typeof r.normalized === "number");
  const missing = results.filter((r) => typeof r.normalized !== "number");
  const partial = results.some((r) => r.status === "pending");
  const gates = results.filter((r) => r.gate).map((r) => ({ criterion: r.criterionId, ...r.gate! }));

  const included: CriterionResult[] = [];
  const excluded: string[] = [];
  for (const r of results) {
    const c = byId.get(r.criterionId)!;
    if (typeof r.normalized === "number") {
      if (c.weight === 0) excluded.push(r.criterionId); else included.push(r);
      continue;
    }
    if (c.optional || aggregation.missing === "exclude") { excluded.push(r.criterionId); continue; }
    if (aggregation.missing === "zero") { included.push({ ...r, normalized: 0, score: scaleRange(criterionScale(rubric, c))[0] }); continue; }
    // missing === "fail"
    return { method: aggregation.method, range: outRange(aggregation), gates, partial, included: [], excluded: results.map((x) => x.criterionId), passed: false };
  }

  const empty: AggregateResult = { method: aggregation.method, range: outRange(aggregation), gates, partial, included: included.map((r) => r.criterionId), excluded };
  if (!included.length) return empty;

  let raw: number;
  let natural: [number, number];
  const n = included.map((r) => r.normalized!);
  const w = included.map((r) => byId.get(r.criterionId)!.weight);
  const wsum = w.reduce((a, b) => a + b, 0) || 1;

  switch (aggregation.method) {
    case "weighted_mean": raw = n.reduce((s, x, i) => s + x * w[i]!, 0) / wsum; natural = [0, 1]; break;
    case "mean": raw = mean(n); natural = [0, 1]; break;
    case "median": raw = median([...n].sort((a, b) => a - b)); natural = [0, 1]; break;
    case "min": raw = Math.min(...n); natural = [0, 1]; break;
    case "max": raw = Math.max(...n); natural = [0, 1]; break;
    case "geometric_mean": raw = Math.exp(n.reduce((s, x, i) => s + (w[i]! / wsum) * Math.log(Math.max(x, 1e-9)), 0)); natural = [0, 1]; break;
    case "weighted_sum": {
      // sum of raw scores * weight; natural range = sum of weighted scale maxima
      raw = included.reduce((s, r) => s + r.score! * byId.get(r.criterionId)!.weight, 0);
      const lo = included.reduce((s, r) => s + scaleRange(criterionScale(rubric, byId.get(r.criterionId)!))[0] * byId.get(r.criterionId)!.weight, 0);
      const hi = included.reduce((s, r) => s + scaleRange(criterionScale(rubric, byId.get(r.criterionId)!))[1] * byId.get(r.criterionId)!.weight, 0);
      natural = [lo, hi];
      break;
    }
    case "formula": {
      const scope: Record<string, number> = {};
      for (const r of results) {
        const c = byId.get(r.criterionId)!;
        const has = typeof r.normalized === "number";
        scope[c.id] = has ? r.score! : scaleRange(criterionScale(rubric, c))[0];
        scope[`${c.id}_n`] = has ? r.normalized! : 0;
        scope[`${c.id}_w`] = c.weight;
        scope[`${c.id}_present`] = has ? 1 : 0;
      }
      raw = evaluateExpression(aggregation.formula!, scope);
      // A formula is assumed to yield 0..1 unless it is obviously on a wider range.
      natural = raw >= 0 && raw <= 1 ? [0, 1] : [0, 100];
      break;
    }
  }

  const range = outRange(aggregation);
  const score = range ? rescale(raw, natural, range) : raw;
  const rounded = round(score, aggregation.precision);
  const gatesPassed = gates.every((g) => g.passed);
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
  if (from[1] === from[0]) return to[0];
  return to[0] + ((clamp(x, from[0], from[1]) - from[0]) * (to[1] - to[0])) / (from[1] - from[0]);
}
export function clamp(x: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, x)); }
export function mean(a: number[]) { return a.reduce((s, x) => s + x, 0) / a.length; }
export function median(sorted: number[]) { const m = sorted.length >> 1; return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2; }
export function round(x: number, p: number) { const m = 10 ** p; return Math.round(x * m) / m; }
