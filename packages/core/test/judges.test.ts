import { describe, expect, it } from "vitest";
import { BenchmarkJudge } from "../src/judges/benchmark.js";
import { LlmJudge, buildSystemPrompt } from "../src/judges/llm.js";
import { parseRubric } from "../src/schema/rubric.js";
import type { JudgeContext } from "../src/judges/types.js";
import { stats } from "../src/ingest/index.js";

const rubric = parseRubric({ name: "r", criteria: [{ id: "x", name: "Clarity", anchors: { "0": "unreadable", "10": "crystal clear" } }] });
const ctx = (text: string, json?: unknown): JudgeContext => ({
  rubric, criterion: rubric.criteria[0]!, scale: rubric.scale,
  evidence: [{ inputIndex: 0, kind: "text", label: "doc", tags: ["doc"], text, json, stats: stats(text) }],
  evaluationId: "e", env: () => undefined, fetch: globalThis.fetch, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 },
});

describe("benchmark judge", () => {
  it("regex", async () => {
    const [r] = await new BenchmarkJudge({ method: "regex", pattern: "\\bAPI\\b", negate: false }).rate(ctx("Our API is fast"));
    expect(r!.score).toBe(10);
    const [n] = await new BenchmarkJudge({ method: "regex", pattern: "lorem ipsum", flags: "i", negate: true }).rate(ctx("Lorem Ipsum dolor"));
    expect(n!.score).toBe(0);
  });
  it("keywords ratio", async () => {
    const [r] = await new BenchmarkJudge({ method: "keywords", keywords: ["revenue", "churn", "cac"], mode: "ratio", caseSensitive: false }).rate(ctx("Revenue grew; churn fell."));
    expect(r!.normalized).toBeCloseTo(2 / 3);
    expect(r!.score).toBeCloseTo(6.67, 1);
  });
  it("length window with tolerance", async () => {
    const j = new BenchmarkJudge({ method: "length", unit: "words", min: 3, max: 5, tolerance: 0.5 });
    expect((await j.rate(ctx("one two three four")))[0]!.normalized).toBe(1);
    expect((await j.rate(ctx("one two three four five six")))[0]!.normalized).toBe(0);
  });
  it("jsonpath with map and range", async () => {
    const j = new BenchmarkJudge({ method: "jsonpath", path: "metrics.nps", range: [-100, 100] });
    expect((await j.rate(ctx("", { metrics: { nps: 50 } })))[0]!.normalized).toBe(0.75);
    const m = new BenchmarkJudge({ method: "jsonpath", path: "stage", map: { seed: 0.3, series_a: 0.7 } });
    expect((await m.rate(ctx("", { stage: "series_a" })))[0]!.score).toBe(7);
  });
  it("formula over evidence stats and json numbers", async () => {
    const j = new BenchmarkJudge({ method: "formula", expression: "clamp(words / 10, 0, 1) * (kpi.growth > 0.2 ? 1 : 0.5)" });
    const [r] = await j.rate(ctx("a b c d e f g h i j k l", { kpi: { growth: 0.3 } }));
    expect(r!.normalized).toBe(1);
  });
  it("similarity", async () => {
    const j = new BenchmarkJudge({ method: "similarity", reference: "the quick brown fox" });
    expect((await j.rate(ctx("the quick brown fox")))[0]!.normalized).toBeCloseTo(1);
    expect((await j.rate(ctx("completely different words")))[0]!.normalized).toBe(0);
  });
  it("returns error ratings instead of throwing", async () => {
    const [r] = await new BenchmarkJudge({ method: "jsonpath", path: "nope" }).rate(ctx("no json"));
    expect(r!.status).toBe("error");
  });
});

describe("llm judge", () => {
  it("builds a prompt with anchors and scale", () => {
    const p = buildSystemPrompt(ctx("hi"), "Be harsh.");
    expect(p).toContain("Criterion: Clarity");
    expect(p).toContain("between 0 and 10");
    expect(p).toContain("crystal clear");
    expect(p).toContain("Be harsh.");
  });
  it("uses the mock provider and self-consistency sampling", async () => {
    const j = new LlmJudge({ type: "llm", provider: "mock", samples: 3, options: { score: 7.6 } });
    const c = ctx("some text");
    const [r] = await j.rate(c);
    expect(r!.status).toBe("scored");
    expect(r!.score).toBe(7.6);
    expect(c.usage.llmCalls).toBe(3);
    expect((r!.raw as { samples: number[] }).samples).toHaveLength(3);
  });
  it("reports unknown providers as errors", async () => {
    const j = new LlmJudge({ type: "llm", provider: "nope" as never, samples: 1 });
    const [r] = await j.rate(ctx("x"));
    expect(r!.status).toBe("error");
    expect(r!.error).toMatch(/unknown LLM provider/);
  });
});
