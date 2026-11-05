import { describe, expect, it } from "vitest";
import { calibrate, krippendorffAlpha, Engine } from "../src/index.js";

async function evaluated(probabilities: number[], scores: number[], escalate = false, rater = "mean") {
  const engine = new Engine();
  let ev = await engine.evaluate({
    rubric: {
      name: "Calibration", scale: { type: "numeric", min: 0, max: 1, step: 1 },
      criteria: [{ id: "quality", name: "Quality", rater, levels: [{ value: 0, description: "bad" }, { value: 1, description: "good" }],
        judge: [
          { type: "decision", provider: "mock", options: { probabilities }, ...(escalate ? { minConfidence: 1, onLowConfidence: "human" } : {}) },
          ...(!escalate ? [{ type: "human", required: scores.length }] : []),
        ] }],
    }, subject: { inputs: [{ type: "text", text: "example" }] },
  });
  for (const [i, score] of scores.entries()) ev = await engine.submitScore(ev.id, { criterionId: "quality", raterId: `rater${i}`, score });
  return ev;
}

describe("calibration", () => {
  it("pairs decisions with consensus, places boundary confidences, and computes ECE", async () => {
    const low = await evaluated([0.5, 0.5], [0]); // confidence 0; expected value snaps to 1
    const high = await evaluated([0, 1], [1]); // confidence 1
    const report = calibrate([low, high], { buckets: 2 });
    expect(report.overall.n).toBe(2);
    expect(report.overall.evaluations).toBe(2);
    expect(report.overall.agreement).toBe(0.5);
    expect(report.overall.meanAbsError).toBe(0.25);
    expect(report.overall.bias).toBe(0.25);
    expect(report.overall.buckets.map((b) => b.n)).toEqual([1, 1]);
    expect(report.overall.ece).toBe(0.25); // .5*|0-.25| + .5*|1-.75|
    expect(report.overall.suggestedMinConfidence).toBeNull();
    expect(report.criteria[0]!.n).toBe(2);
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
  });

  it("suggests only thresholds with sufficient agreement and support in every higher bin", async () => {
    const high = await Promise.all(Array.from({ length: 3 }, () => evaluated([0, 1], [1])));
    const low = await evaluated([0.5, 0.5], [0]);
    expect(calibrate([...high, low], { buckets: 2 }).overall.suggestedMinConfidence).toBe(0.5);
    const lows = await Promise.all(Array.from({ length: 3 }, () => evaluated([0.5, 0.5], [1])));
    expect(calibrate([...high, ...lows], { buckets: 2 }).overall.suggestedMinConfidence).toBe(0);
    expect(calibrate(lows, { buckets: 2 }).overall.suggestedMinConfidence).toBe(0); // empty top bucket is skipped, not disqualifying
    const twoHigh = await Promise.all(Array.from({ length: 2 }, () => evaluated([0, 1], [1])));
    expect(calibrate([...twoHigh, ...lows], { buckets: 2 }).overall.suggestedMinConfidence).toBeNull(); // 2 pairs in the top bucket: insufficient evidence
    expect(calibrate([...high, low], { buckets: 2, target: 0 }).overall.suggestedMinConfidence).toBe(0.5);
  });

  it("includes escalated originals after submitScore and does not mutate evaluations", async () => {
    const ev = await evaluated([0.5, 0.5], [0], true);
    const snapshot = JSON.stringify(ev);
    const report = calibrate([ev]);
    expect(report.overall.n).toBe(1);
    expect(report.overall.buckets[0]!.n).toBe(1);
    expect(report.overall.agreement).toBe(0);
    expect(JSON.stringify(ev)).toBe(snapshot);
  });

  it("aggregates only humans using the criterion override and filters criteria", async () => {
    const ev = await evaluated([0, 1], [0, 1, 1], false, "min");
    expect(calibrate([ev]).overall.agreement).toBe(0);
    expect(calibrate([ev]).overall.meanAbsError).toBe(1);
    expect(calibrate([ev], { criteria: [] }).overall.n).toBe(0);
    const other = structuredClone(ev);
    other.rubric.criteria[0]!.rater = undefined;
    other.rubric.aggregation.rater = "max";
    expect(calibrate([other]).overall.agreement).toBe(1);
  });

  it("counts every independent decision, skips missing humans, and uses frozen scales", async () => {
    const ev = await evaluated([0, 1], [1]);
    ev.criteria[0]!.ratings.push({ ...ev.criteria[0]!.ratings.find((r) => r.judgeType === "decision")!, id: "second" });
    expect(calibrate([ev]).overall.n).toBe(2);
    ev.criteria[0]!.ratings = ev.criteria[0]!.ratings.filter((r) => r.judgeType !== "human");
    expect(calibrate([ev]).overall.evaluations).toBe(0);
    expect(calibrate([ev]).overall.agreement).toBeNull();
  });

  it("reports alpha from human units once per evaluation rather than per decision", async () => {
    const a = await evaluated([0, 1], [0, 0]);
    const b = await evaluated([0, 1], [1, 1]);
    expect(calibrate([a, b]).overall.humanAgreement).toBe(1);
    expect(calibrate([a, b]).criteria[0]!.humanAgreement).toBe(1);
  });

  it("handles empty reports and rejects invalid options", () => {
    expect(calibrate([]).overall.n).toBe(0);
    expect(calibrate([]).overall.ece).toBeNull();
    expect(calibrate([]).overall.humanAgreement).toBeNull();
    for (const buckets of [0, 1.5, Infinity, 1001]) expect(() => calibrate([], { buckets })).toThrow();
    for (const target of [-1, 2, NaN]) expect(() => calibrate([], { target })).toThrow();
  });
});

describe("interval Krippendorff alpha", () => {
  it("is one for perfect agreement with variation between units", () => {
    expect(krippendorffAlpha([[0, 0], [1, 1]])).toBe(1);
  });
  it("matches a hand-computed mixed example", () => {
    // Units (0,0), (0,1), (1,1). Do = 2/6 = 1/3;
    // pooled values: three zeros, three ones; De = 18/(6*5) = 3/5.
    expect(krippendorffAlpha([[0, 0], [0, 1], [1, 1]])).toBeCloseTo(4 / 9);
  });
  it("weights unequal rater counts and excludes singleton units", () => {
    // Do = (4/2 + 2/1)/5 = .8; De = 12/20 = .6
    expect(krippendorffAlpha([[0, 0, 1], [0, 1], [100]])).toBeCloseTo(-1 / 3);
    expect(krippendorffAlpha([])).toBeNull();
    expect(krippendorffAlpha([[1, 1]])).toBeNull();
  });
});
