/**
 * Measures decision confidence against independent human consensus.
 * Escalated decisions retain their original prediction; missing overlap produces unavailable statistics.
 */
import { aggregateNumbers, criterionScale, denormalizeScore, normalizeScore } from "./aggregate/index.js";
import type { Criterion } from "./schema/rubric.js";
import type { Evaluation, Rating } from "./schema/evaluation.js";

export interface CalibrationOptions { target?: number; buckets?: number; criteria?: string[] }
export interface CalibrationBucket {
  from: number; to: number; n: number; agreement: number | null; meanAbsError: number | null;
}
export interface CalibrationMetrics {
  n: number;
  meanAbsError: number | null;
  agreement: number | null;
  bias: number | null;
  buckets: CalibrationBucket[];
  ece: number | null;
  suggestedMinConfidence: number | null;
  humanAgreement: number | null;
}
export interface CalibrationReport {
  criteria: Array<CalibrationMetrics & { criterionId: string }>;
  overall: CalibrationMetrics & { evaluations: number };
  generatedAt: string;
}

/** Interval Krippendorff alpha. Units with fewer than two observations are excluded.
 * Coincidences weight each unit's ordered pairs by 1/(raters - 1).
 */
export function krippendorffAlpha(units: number[][]): number | null {
  const eligible = units.filter((u) => u.length >= 2);
  const values = eligible.flat();
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const expected = 2 * values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  // why: constant observations have no chance disagreement, so alpha is undefined rather than perfect.
  if (expected === 0) return null;
  let observed = 0;
  for (const unit of eligible) {
    const center = unit.reduce((s, v) => s + v, 0) / unit.length;
    observed += 2 * unit.length * unit.reduce((s, v) => s + (v - center) ** 2, 0) / (unit.length - 1);
  }
  return 1 - observed / n / expected;
}

const MIN_CALIBRATION_PAIRS = 3;

/** `error` is the normalized difference; choice criteria without values have none and only count toward agreement. */
type Pair = { error?: number; agrees: number; confidence?: number };
type Sample = { pairs: Pair[]; humans: number[][] };

function summarise(sample: Sample, count: number, target: number): CalibrationMetrics {
  const { pairs } = sample;
  const average = (xs: Pair[], value: (p: Pair) => number) => xs.length ? xs.reduce((s, p) => s + value(p), 0) / xs.length : null;
  const numeric = (xs: Pair[]) => xs.filter((p) => p.error !== undefined);
  const bins: Pair[][] = Array.from({ length: count }, () => []);
  for (const pair of pairs) {
    if (pair.confidence !== undefined && Number.isFinite(pair.confidence) && pair.confidence >= 0 && pair.confidence <= 1) {
      // why: confidence=1 belongs to the final bin, not an out-of-range extra bucket.
      bins[Math.min(count - 1, Math.floor(pair.confidence * count))]!.push(pair);
    }
  }
  const buckets = bins.map((bin, i) => ({
    from: i / count, to: (i + 1) / count, n: bin.length,
    agreement: average(bin, (p) => p.agrees), meanAbsError: average(numeric(bin), (p) => Math.abs(p.error!))
  }));
  // Lowest bucket such that every populated bucket at or above it meets `target` with >= 3 pairs.
  // Empty buckets are skipped (no evidence either way); 1-2 pairs is insufficient evidence and stops the search.
  let suggestedMinConfidence: number | null = null;
  for (let i = count - 1; i >= 0; i--) {
    const b = buckets[i]!;
    if (b.n === 0) continue;
    if (b.n < MIN_CALIBRATION_PAIRS || b.agreement! < target) break;
    suggestedMinConfidence = b.from;
  }
  return {
    n: pairs.length, meanAbsError: average(numeric(pairs), (p) => Math.abs(p.error!)), agreement: average(pairs, (p) => p.agrees),
    bias: average(numeric(pairs), (p) => p.error!), buckets,
    ece: pairs.length ? buckets.reduce((s, b) => s + b.n / pairs.length * Math.abs((b.agreement ?? 0) - (b.from + b.to) / 2), 0) : null,
    suggestedMinConfidence, humanAgreement: krippendorffAlpha(sample.humans),
  };
}

/** Read only frozen evaluation snapshots; never invokes judges or changes stored scores. */
export function calibrate(evaluations: Evaluation[], options: CalibrationOptions = {}): CalibrationReport {
  const target = options.target ?? 0.8, count = options.buckets ?? 5;
  if (!Number.isFinite(target) || target < 0 || target > 1) throw new RangeError("target must be between 0 and 1");
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new RangeError("buckets must be an integer between 1 and 1000");
  const samples = new Map<string, Sample>();
  const overall: Sample = { pairs: [], humans: [] };
  let used = 0;
  for (const evaluation of evaluations) {
    let contributed = false;
    for (const criterion of evaluation.rubric.criteria) {
      if (options.criteria && !options.criteria.includes(criterion.id)) continue;
      let sample = samples.get(criterion.id);
      if (!sample) { sample = { pairs: [], humans: [] }; samples.set(criterion.id, sample); }
      const collected = collectPairs(evaluation, criterion);
      sample.pairs.push(...collected.pairs);
      sample.humans.push(...collected.humans);
      overall.pairs.push(...collected.pairs);
      overall.humans.push(...collected.humans);
      contributed ||= collected.pairs.length > 0;
    }
    if (contributed) used++;
  }
  return {
    criteria: [...samples].map(([criterionId, sample]) => ({ criterionId, ...summarise(sample, count, target) })),
    overall: { ...summarise(overall, count, target), evaluations: used }, generatedAt: new Date().toISOString()
  };
}

function collectPairs(evaluation: Evaluation, criterion: Criterion): Sample {
  const ratings = evaluation.criteria.find((c) => c.criterionId === criterion.id)?.ratings ?? [];
  return criterion.choices ? collectChoicePairs(evaluation, criterion, ratings) : collectScorePairs(evaluation, criterion, ratings);
}

function collectScorePairs(evaluation: Evaluation, criterion: Criterion, ratings: Rating[]): Sample {
  const sample: Sample = { pairs: [], humans: [] };
  const humans = ratings.filter((r) => r.judgeType === "human" && r.status === "scored" && Number.isFinite(r.normalized)).map((r) => r.normalized!);
  if (humans.length >= 2) { sample.humans.push(humans); }
  const consensus = aggregateNumbers(humans, criterion.rater ?? evaluation.rubric.aggregation.rater);
  if (consensus === undefined) return sample;
  const scale = criterionScale(evaluation.rubric, criterion);
  for (const decision of decisionRatings(ratings, (r) => Number.isFinite(r.normalized))) {
    const pair: Pair = {
      error: decision.normalized! - consensus,
      agrees: Number(denormalizeScore(decision.normalized!, scale) === denormalizeScore(consensus, scale)), confidence: decision.confidence
    };
    sample.pairs.push(pair);
  }
  return sample;
}

/**
 * Choice criteria compare option ids against the human majority (ties follow declaration order, as aggregation does).
 * Interval alpha does not apply to categories, so choice criteria report no human agreement.
 */
function collectChoicePairs(evaluation: Evaluation, criterion: Criterion, ratings: Rating[]): Sample {
  const sample: Sample = { pairs: [], humans: [] };
  const humans = ratings.filter((r) => r.judgeType === "human" && r.status === "scored" && r.choice !== undefined).map((r) => r.choice!);
  if (!humans.length) return sample;
  const options = Object.keys(criterion.choices!);
  const counts = options.map((o) => humans.filter((h) => h === o).length);
  const consensus = options[counts.indexOf(Math.max(...counts))]!;
  // why: a value map gives choices a distance; without one, a wrong option has no size, only a disagreement.
  const target = criterion.values?.[consensus];
  const expected = target === undefined ? undefined : normalizeScore(target, criterionScale(evaluation.rubric, criterion));
  for (const decision of decisionRatings(ratings, (r) => r.choice !== undefined)) {
    const error = expected !== undefined && Number.isFinite(decision.normalized) ? decision.normalized! - expected : undefined;
    sample.pairs.push({ agrees: Number(decision.choice === consensus), confidence: decision.confidence, ...(error !== undefined ? { error } : {}) });
  }
  return sample;
}

/** Decision ratings, including originals kept inside escalated human slots; each id counted once. */
function decisionRatings(ratings: Rating[], usable: (r: Rating) => boolean): Rating[] {
  const decisions = new Map<string, Rating>();
  for (const rating of ratings) {
    const original = rating.raw && "escalatedFrom" in rating.raw ? rating.raw.escalatedFrom : undefined;
    for (const r of [rating, original]) {
      if (r?.judgeType === "decision" && r.status === "scored" && usable(r as Rating)) decisions.set(r.id ?? rating.id, r as Rating);
    }
  }
  return [...decisions.values()];
}
