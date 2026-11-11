import type { Criterion, Rubric, Scale } from "../schema/rubric.js";
import { ValidationError } from "../engine/errors.js";
import { clamp, round } from "./numbers.js";

/** Returns the inclusive raw scale bounds; expects a validated, nonempty scale. */
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

/** Returns the criterion override or rubric default scale; never performs I/O. */
export function criterionScale(rubric: Rubric, c: Criterion): Scale {
  return c.scale ?? rubric.scale;
}

/** Map a raw score on `scale` to 0..1. */
export function normalizeScore(score: number, scale: Scale): number {
  if (!Number.isFinite(score)) throw new ValidationError("score must be finite");
  const [lo, hi] = scaleRange(scale);
  if (hi === lo) return score >= hi ? 1 : 0;
  return clamp((score - lo) / (hi - lo), 0, 1);
}

/** Map 0..1 to a raw score on `scale`, honoring step / ordinal values. */
export function denormalizeScore(n: number, scale: Scale): number {
  if (!Number.isFinite(n)) throw new ValidationError("normalized score must be finite");
  const [lo, hi] = scaleRange(scale);
  const v = lo + clamp(n, 0, 1) * (hi - lo);
  return snapToScale(v, scale);
}

/** Snap a raw score onto the scale (step, ordinal values, binary). */
export function snapToScale(v: number, scale: Scale): number {
  if (!Number.isFinite(v)) throw new ValidationError("score must be finite");
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
  throw new ValidationError(`cannot interpret score "${input}" on scale ${scale.type}`);
}

/** Returns a binary or ordinal label, or undefined for numeric scales. */
export function scoreLabel(score: number, scale: Scale): string | undefined {
  if (scale.type === "ordinal") {
    const vals = scale.values ?? scale.labels.map((_, i) => i);
    const i = vals.indexOf(score);
    return i >= 0 ? scale.labels[i] : undefined;
  }
  if (scale.type === "binary" && scale.labels) return scale.labels[score >= 0.5 ? 1 : 0];
  return undefined;
}
