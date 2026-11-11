import { expect, it, vi } from "vitest";
import * as nodeFs from "node:fs/promises";
import { aggregateCriteria, aggregateNumbers, aggregateRatings, coerceScore, denormalizeScore, normalizeScore, snapToScale } from "../src/aggregate/index.js";
import { ValidationError } from "../src/engine/errors.js";
import { parseRubric, type Aggregation, type RaterAggregation } from "../src/schema/rubric.js";
import { FileStore } from "../src/store/index.js";

const scale = { type: "numeric" as const, min: 0, max: 10 };

it.each([NaN, Infinity, -Infinity])("rejects nonfinite score %s at scale and rater boundaries", value => {
  for (const convert of [normalizeScore, snapToScale, denormalizeScore, coerceScore]) {
    expect(() => convert(value, scale)).toThrow(ValidationError);
  }
  expect(() => aggregateNumbers([1, value], "mean")).toThrow(ValidationError);
});

it("rejects unknown aggregation methods instead of invoking an absent handler", () => {
  expect(() => aggregateNumbers([1], "typo" as RaterAggregation)).toThrow("unknown rater aggregation method");
  const rubric = parseRubric({ name: "Test", criteria: [{ id: "a", name: "A" }] });
  const result = { ...aggregateRatings(rubric, rubric.criteria[0]!, [], 0), score: 5, normalized: 0.5 };
  expect(() => aggregateCriteria(rubric, [result], { ...rubric.aggregation, method: "typo" as Aggregation["method"] })).toThrow("unknown aggregation method");
});

it("rejects invalid stored criterion results while retaining empty aggregate semantics", () => {
  const rubric = parseRubric({ name: "Test", criteria: [{ id: "a", name: "A" }] });
  const result = aggregateRatings(rubric, rubric.criteria[0]!, [], 0);
  expect(aggregateCriteria(rubric, []).score).toBeUndefined();
  expect(() => aggregateCriteria(rubric, [{ ...result, criterionId: "missing" }])).toThrow("unknown criterion");
  expect(() => aggregateCriteria(rubric, [{ ...result, normalized: NaN }])).toThrow("nonfinite score");
  expect(() => aggregateCriteria(rubric, [], { ...rubric.aggregation, method: "formula", formula: "pow(10, 1000)" })).toThrow();
  rubric.criteria[0]!.weight = -1;
  expect(() => aggregateCriteria(rubric, [{ ...result, score: 5, normalized: 0.5 }])).toThrow("total criterion weight");
});

it("uses injected filesystem operations and reports failures without accessing disk", async () => {
  const readFile = vi.fn<typeof nodeFs.readFile>().mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
  const readdir = vi.fn<typeof nodeFs.readdir>().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const store = new FileStore("/virtual", { ...nodeFs, readFile, readdir });
  await expect(store.getEvaluation("e")).rejects.toMatchObject({ name: "FileAccessError", cause: expect.objectContaining({ code: "EACCES" }) });
  expect(await store.listEvaluations()).toEqual([]);
  expect(readFile).toHaveBeenCalledWith("/virtual/evaluations/e.json", "utf8");
  expect(readdir).toHaveBeenCalledWith("/virtual/evaluations");
});

it.each(["decision", "llm"])("names missing explicit credentials in %s error ratings without calling a provider", async type => {
  const { Engine } = await import("../src/engine.js");
  const fetch = vi.fn<typeof globalThis.fetch>();
  const engine = new Engine({ fetch, env: () => undefined });
  const result = await engine.evaluate({
    rubric: { name: "Missing key", defaultJudge: { type, provider: "mock", apiKeyEnv: "PROJECT_JUDGE_KEY" }, criteria: [{ id: "a", name: "A" }] },
    subject: { inputs: [{ type: "text", text: "hello" }] },
  });
  expect(result.criteria[0]!.ratings[0]).toMatchObject({ status: "error", error: expect.stringContaining("missing credential: PROJECT_JUDGE_KEY") });
  expect(fetch).not.toHaveBeenCalled();
});
