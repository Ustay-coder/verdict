import { describe, expect, it } from "vitest";
import { parseRubric } from "../src/schema/rubric.js";
import { aggregateCriteria, aggregateNumbers, aggregateRatings, coerceScore, normalizeScore, snapToScale } from "../src/aggregate/index.js";
import type { Rating } from "../src/schema/evaluation.js";

const rating = (criterionId: string, score: number, extra: Partial<Rating> = {}): Rating => ({
  id: `r_${Math.random()}`, criterionId, raterId: "t", judgeType: "benchmark", status: "scored", score, normalized: score / 10, createdAt: "", ...extra,
});

const rubric = parseRubric({
  name: "t",
  criteria: [
    { id: "a", name: "A", weight: 2 },
    { id: "b", name: "B", weight: 1 },
    { id: "c", name: "C", weight: 1, optional: true },
  ],
  aggregation: { gates: [{ criterion: "b", min: 3 }], grades: [{ label: "A", min: 90 }, { label: "B", min: 70 }, { label: "C", min: 0 }], passThreshold: 60 },
});

describe("scales", () => {
  it("normalizes and snaps", () => {
    expect(normalizeScore(5, { type: "numeric", min: 0, max: 10 })).toBe(0.5);
    expect(snapToScale(7.3, { type: "numeric", min: 0, max: 10, step: 0.5 })).toBe(7.5);
    expect(snapToScale(12, { type: "numeric", min: 0, max: 10 })).toBe(10);
    expect(snapToScale(0.4, { type: "binary" })).toBe(0);
    expect(snapToScale(1.4, { type: "ordinal", labels: ["poor", "ok", "great"] })).toBe(1);
  });
  it("coerces labels", () => {
    expect(coerceScore("great", { type: "ordinal", labels: ["poor", "ok", "great"] })).toBe(2);
    expect(coerceScore("pass", { type: "binary" })).toBe(1);
    expect(coerceScore("7", { type: "numeric", min: 0, max: 10 })).toBe(7);
    expect(() => coerceScore("banana", { type: "numeric", min: 0, max: 10 })).toThrow();
  });
});

describe("rater aggregation", () => {
  it("implements mean/median/trimmed/majority", () => {
    expect(aggregateNumbers([1, 2, 9], "mean")).toBe(4);
    expect(aggregateNumbers([1, 2, 9], "median")).toBe(2);
    expect(aggregateNumbers([1, 5, 5, 5, 9], "trimmed_mean")).toBe(5);
    expect(aggregateNumbers([3, 3, 7], "majority")).toBe(3);
    expect(aggregateNumbers([], "mean")).toBeUndefined();
  });
  it("marks criteria pending until all expected ratings arrive", () => {
    const c = rubric.criteria[0]!;
    const pending = aggregateRatings(rubric, c, [rating("a", 8), rating("a", 0, { status: "pending", score: undefined, normalized: undefined })], 2);
    expect(pending.status).toBe("pending");
    expect(pending.score).toBe(8);
    expect(pending.pending).toBe(1);
    const done = aggregateRatings(rubric, c, [rating("a", 8), rating("a", 6)], 2);
    expect(done.status).toBe("scored");
    expect(done.score).toBe(7);
  });
});

describe("overall aggregation", () => {
  const results = [
    aggregateRatings(rubric, rubric.criteria[0]!, [rating("a", 8)], 1),
    aggregateRatings(rubric, rubric.criteria[1]!, [rating("b", 6)], 1),
    aggregateRatings(rubric, rubric.criteria[2]!, [], 0),
  ];
  it("computes weighted mean on 0..100 with grades, gates and pass", () => {
    const agg = aggregateCriteria(rubric, results);
    // (0.8*2 + 0.6*1) / 3 = 0.7333 -> 73.33
    expect(agg.score).toBeCloseTo(73.33, 2);
    expect(agg.grade).toBe("B");
    expect(agg.passed).toBe(true);
    expect(agg.included).toEqual(["a", "b"]);
    expect(agg.excluded).toEqual(["c"]);
    expect(agg.partial).toBe(false);
  });
  it("fails gates", () => {
    const low = [results[0]!, aggregateRatings(rubric, rubric.criteria[1]!, [rating("b", 2)], 1), results[2]!];
    const agg = aggregateCriteria(rubric, low);
    expect(agg.gates[0]!.passed).toBe(false);
    expect(agg.passed).toBe(false);
  });
  it("supports every method", () => {
    const m = (method: string, extra = {}) => aggregateCriteria(rubric, results, { ...rubric.aggregation, method: method as never, ...extra }).score;
    expect(m("mean")).toBeCloseTo(70);
    expect(m("median")).toBeCloseTo(70);
    expect(m("min")).toBeCloseTo(60);
    expect(m("max")).toBeCloseTo(80);
    expect(m("weighted_sum")).toBeCloseTo(((8 * 2 + 6) / 30) * 100);
    expect(m("weighted_sum", { normalize: false })).toBe(22);
    expect(m("geometric_mean")).toBeCloseTo(Math.exp((2 * Math.log(0.8) + Math.log(0.6)) / 3) * 100, 1);
    expect(m("formula", { formula: "a_n * 0.9 + b_n * 0.1" })).toBeCloseTo(78);
    expect(m("formula", { formula: "min(a, b) >= 5 ? 1 : 0" })).toBe(100);
  });
  it("respects missing=zero / fail", () => {
    const strict = parseRubric({ ...rubric, criteria: rubric.criteria.map((c) => ({ ...c, optional: false })) });
    expect(aggregateCriteria(strict, results, { ...strict.aggregation, missing: "zero" }).score).toBeCloseTo((0.8 * 2 + 0.6) / 4 * 100);
    expect(aggregateCriteria(strict, results, { ...strict.aggregation, missing: "fail" }).score).toBeUndefined();
  });
});
