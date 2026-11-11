import type { Criterion, Scale } from "../../schema/rubric.js";
import { normalizeScore, snapToScale } from "../../aggregate/index.js";
import type { SystemOneAnswer } from "./contracts.js";
import type { Level } from "./questions.js";
// Prevent division by zero when a provider distribution has zero total mass.
const MIN_PROBABILITY_MASS = 1e-9;
// Four decimal places keep persisted distributions compact and stable.
const PROBABILITY_PRECISION = 10_000;

/**
 * Turn a System One answer into a raw score on the criterion scale + per-level probabilities.
 * `threshold` is the P(true) at or above which a binary answer counts as the true label (default 0.5).
 */
export function answerToScore(answer: SystemOneAnswer, levels: Level[], scale: Scale, threshold = DEFAULT_BINARY_THRESHOLD): { score: number; normalized: number; probabilities: Record<string, number>; confidence: number } {
  if (scale.type === "binary" || typeof answer.noul === "number") {
    return binaryAnswer(answer, levels, scale, threshold);
  }

  const probs = toProbArray(answer.probabilities, levels.length);
  let expected: number;
  if (probs) expected = probs.reduce((s, p, i) => s + p * (levels[i]?.value ?? i), 0) / Math.max(MIN_PROBABILITY_MASS, probs.reduce((s, p) => s + p, 0));
  else if (typeof answer.score === "number") {
    // why: providers report level indices, so fractional indices interpolate criterion values rather than becoming raw scores.
    const idx = Math.min(Math.max(answer.score, 0), levels.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    expected = levels[lo]!.value + (levels[hi]!.value - levels[lo]!.value) * (idx - lo);
  } else throw new Error("decision answer has neither probabilities nor score");
  const score = snapToScale(expected, scale);
  const probabilities = Object.fromEntries(levels.map((l, i) => [l.label, r4(probs ? probs[i]! : i === Math.round(answer.score ?? 0) ? 1 : 0)]));
  return { score, normalized: normalizeScore(expected, scale), probabilities, confidence: answer.confidence ?? (probs ? concentration(probs) : SCORE_ONLY_CONFIDENCE) };
}

function binaryAnswer(answer: SystemOneAnswer, levels: Level[], scale: Scale, threshold: number) {
  const p = typeof answer.noul === "number" ? answer.noul : answer.score !== undefined ? answer.score / Math.max(1, levels.length - 1) : 0;
  const [no, yes] = levels.length >= 2 ? levels : [{ label: "no" }, { label: "yes" }];
  const label = p >= threshold ? 1 : 0;
  return { score: label, normalized: normalizeScore(label, scale), probabilities: { [no!.label]: r4(1 - p), [yes!.label]: r4(p) }, confidence: r4(binaryMargin(p, threshold)) };
}

/**
 * Distance of P(true) from the decision threshold, scaled to 0..1 on the side the answer falls (|2p − 1| at 0.5).
 * Decision models return no confidence for noul; this is derived from the probability, not reported by the model.
 */
export function binaryMargin(p: number, threshold: number): number {
  return p >= threshold ? (p - threshold) / (1 - threshold) : (threshold - p) / threshold;
}

/** Maps an allowed choice to criterion units; throws when the choice is missing or unknown. */
export function answerToChoice(answer: SystemOneAnswer, c: Criterion, scale: Scale) {
  const choice = answer.choice;
  if (!choice || !Object.hasOwn(c.choices!, choice)) throw new Error("invalid decision choice");
  const probabilities = Object.fromEntries(Object.keys(c.choices!).map(o => [o, answer.probabilities && !Array.isArray(answer.probabilities) ? answer.probabilities[o] ?? 0 : o === choice ? 1 : 0]));
  const score = c.values?.[choice];
  return { choice, score, normalized: score === undefined ? undefined : normalizeScore(score, scale), probabilities, confidence: answer.confidence ?? concentration(Object.values(probabilities)) };
}

// Score-only answers have no measured distribution; use neutral confidence.
const SCORE_ONLY_CONFIDENCE = 0.5;
/** Binary boundary when a criterion sets no `threshold`: equal probability of either label. */
export const DEFAULT_BINARY_THRESHOLD = 0.5;

const r4 = (x: number) => Math.round(x * PROBABILITY_PRECISION) / PROBABILITY_PRECISION;

function toProbArray(p: SystemOneAnswer["probabilities"], n: number): number[] | undefined {
  if (!p) return undefined;
  // why: mismatched distributions cannot align with levels; fall back to the provider score if present.
  if (Array.isArray(p)) return p.length === n ? p : undefined;
  const vals = Object.values(p);
  return vals.length === n ? vals : undefined;
}
/** Choice-style confidence: (p_max - 1/n) / (1 - 1/n). */
function concentration(p: number[]) { const n = p.length; if (n < 2) return 1; return (Math.max(...p) - 1 / n) / (1 - 1 / n); }
