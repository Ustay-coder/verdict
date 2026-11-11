import { describe, expect, it } from "vitest";
import { agreementReport, checkAgainstHumans, Engine, parseGoldSet, parseRubric } from "../src/index.js";

// The mock decision provider answers binary questions with P=0.1 for "spam", 0.9 for "yes", else 0.75 (confidence 0.5).
const rubric = (judge: Record<string, unknown> = {}) => ({
  name: "Good message",
  defaultJudge: { type: "decision", provider: "mock", ...judge },
  criteria: [{ id: "good", name: "Good", scale: { type: "binary", labels: ["no", "yes"] }, anchors: { no: "bad", yes: "good" } }],
  aggregation: { passThreshold: 50 },
});
const item = (name: string, text: string, passed: boolean) => ({ name, inputs: [{ type: "text" as const, text }], human: { passed, criteria: { good: passed } } });

describe("checkAgainstHumans", () => {
  it("counts agreements on the overall verdict and per criterion, with a preview of each subject", async () => {
    const items = [item("a", "spam spam", false), item("b", "yes looks fine", true), item("c", "spam but the humans liked it", true)];
    const report = await checkAgainstHumans(new Engine(), rubric(), items);
    expect(report).toMatchObject({ items: 3, decided: 3, agreed: 2, askedHuman: 0, failed: 0 });
    expect(report.agreement).toBeCloseTo(2 / 3);
    expect(report.criteria.good).toMatchObject({ n: 3, agreed: 2, askedHuman: 0 });
    const c = report.results.find((r) => r.name === "c")!;
    expect(c).toMatchObject({ passed: false, agrees: false, askedHuman: false, preview: "spam but the humans liked it" });
    expect(c.criteria.good).toMatchObject({ verdict: 0, human: 1, agrees: false });
    expect(c.criteria.good!.confidence).toBeCloseTo(0.8);
  });

  it("reports low-confidence subjects as handed to a human instead of agreeing or disagreeing", async () => {
    const items = [item("sure", "yes", true), item("unsure", "no idea", false)];
    const report = await checkAgainstHumans(new Engine(), rubric({ minConfidence: 0.6, onLowConfidence: "human" }), items);
    expect(report).toMatchObject({ decided: 1, agreed: 1, agreement: 1, askedHuman: 1 });
    const unsure = report.results.find((r) => r.name === "unsure")!;
    expect(unsure).toMatchObject({ passed: null, agrees: null, askedHuman: true });
    expect(unsure.criteria.good).toMatchObject({ verdict: null, askedHuman: true, confidence: 0.5 });
    expect(report.criteria.good).toMatchObject({ n: 1, askedHuman: 1 });
  });

  it("parses JSON lines and arrays, resolves relative file paths, and rejects malformed items", () => {
    const lines = `${JSON.stringify({ name: "x", inputs: [{ type: "file", path: "m/x.txt" }, { type: "file", path: "/abs.txt" }], human: { passed: true } })}\n\n`;
    const [x] = parseGoldSet(lines, "/data/gold/");
    expect(x!.inputs).toEqual([{ type: "file", path: "/data/gold/m/x.txt" }, { type: "file", path: "/abs.txt" }]);
    expect(parseGoldSet(JSON.stringify([item("y", "t", false)]))[0]!.name).toBe("y");
    expect(() => parseGoldSet(JSON.stringify([{ name: "z", inputs: [] , human: {} }]))).toThrow(/gold item 1: inputs/);
  });

  it("ignores labels for criteria the rubric doesn't have, and subjects without a human verdict", () => {
    const r = parseRubric(rubric());
    const ev = { id: "e", status: "completed", aggregate: { passed: true, score: 100 }, criteria: [] } as never;
    const report = agreementReport(r, [{ item: { name: "n", inputs: [{ type: "text", text: "t" }], human: { criteria: { gone: 1 } } }, evaluation: ev }]);
    expect(report).toMatchObject({ decided: 0, agreed: 0, agreement: null, criteria: {} });
  });
});
