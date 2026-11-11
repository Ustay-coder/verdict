import type { RaterAggregation } from "../schema/rubric.js";
import { ValidationError } from "../engine/errors.js";

/** Combines rater values by policy; returns undefined for an empty set. */
export function aggregateNumbers(values: number[], method: RaterAggregation | "mean"): number | undefined {
  if (!values.length) return undefined;
  if (values.some(value => !Number.isFinite(value))) throw new ValidationError("rater scores must be finite");
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
  throw new ValidationError(`unknown rater aggregation method: ${method}`);
}

/** Bounds a numeric value inclusively; nonfinite inputs follow JavaScript arithmetic semantics. */
export function clamp(x: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, x)); }
/** Returns the arithmetic mean; an empty input produces NaN. */
export function mean(a: number[]) { return a.reduce((s, x) => s + x, 0) / a.length; }
/** Returns the median of a nonempty ascending array; callers must sort values first. */
export function median(sorted: number[]) { const m = sorted.length >> 1; return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2; }
/** Rounds to decimal precision; nonfinite inputs follow JavaScript arithmetic semantics. */
export function round(x: number, p: number) { const m = 10 ** p; return Math.round(x * m) / m; }
