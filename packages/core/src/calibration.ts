import { aggregateNumbers, criterionScale, denormalizeScore } from "./aggregate/index.js";
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
  if (expected === 0) return null;
  let observed = 0;
  for (const unit of eligible) {
    const center = unit.reduce((s, v) => s + v, 0) / unit.length;
    observed += 2 * unit.length * unit.reduce((s, v) => s + (v - center) ** 2, 0) / (unit.length - 1);
  }
  return 1 - observed / n / expected;
}

type Pair = { error: number; agrees: number; confidence?: number };
type Sample = { pairs: Pair[]; humans: number[][] };

function metrics(sample: Sample, count: number, target: number): CalibrationMetrics {
  const { pairs } = sample;
  const average = (xs: Pair[], value: (p: Pair) => number) => xs.length ? xs.reduce((s, p) => s + value(p), 0) / xs.length : null;
  const bins: Pair[][] = Array.from({ length: count }, () => []);
  for (const pair of pairs) {
    if (pair.confidence !== undefined && Number.isFinite(pair.confidence) && pair.confidence >= 0 && pair.confidence <= 1) {
      bins[Math.min(count - 1, Math.floor(pair.confidence * count))]!.push(pair);
    }
  }
  const buckets = bins.map((bin, i) => ({ from: i / count, to: (i + 1) / count, n: bin.length,
    agreement: average(bin, (p) => p.agrees), meanAbsError: average(bin, (p) => Math.abs(p.error)) }));
  // Lowest bucket such that every populated bucket at or above it meets `target` with >= 3 pairs.
  // Empty buckets are skipped (no evidence either way); 1-2 pairs is insufficient evidence and stops the search.
  let suggestedMinConfidence: number | null = null;
  for (let i = count - 1; i >= 0; i--) {
    const b = buckets[i]!;
    if (b.n === 0) continue;
    if (b.n < 3 || b.agreement! < target) break;
    suggestedMinConfidence = b.from;
  }
  return {
    n: pairs.length, meanAbsError: average(pairs, (p) => Math.abs(p.error)), agreement: average(pairs, (p) => p.agrees),
    bias: average(pairs, (p) => p.error), buckets,
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
      const ratings = evaluation.criteria.find((c) => c.criterionId === criterion.id)?.ratings ?? [];
      const humans = ratings.filter((r) => r.judgeType === "human" && r.status === "scored" && Number.isFinite(r.normalized)).map((r) => r.normalized!);
      if (humans.length >= 2) { sample.humans.push(humans); overall.humans.push(humans); }
      const consensus = aggregateNumbers(humans, criterion.rater ?? evaluation.rubric.aggregation.rater);
      if (consensus === undefined) continue;
      const scale = criterionScale(evaluation.rubric, criterion);
      const decisions = new Map<string, Rating>();
      for (const rating of ratings) {
        const original = rating.raw?.escalatedFrom as Partial<Rating> | undefined;
        for (const r of [rating, original]) {
          if (r?.judgeType === "decision" && r.status === "scored" && Number.isFinite(r.normalized)) decisions.set(r.id ?? rating.id, r as Rating);
        }
      }
      for (const decision of decisions.values()) {
        const pair: Pair = { error: decision.normalized! - consensus,
          agrees: Number(denormalizeScore(decision.normalized!, scale) === denormalizeScore(consensus, scale)), confidence: decision.confidence };
        sample.pairs.push(pair); overall.pairs.push(pair); contributed = true;
      }
    }
    if (contributed) used++;
  }
  return { criteria: [...samples].map(([criterionId, sample]) => ({ criterionId, ...metrics(sample, count, target) })),
    overall: { ...metrics(overall, count, target), evaluations: used }, generatedAt: new Date().toISOString() };
}
