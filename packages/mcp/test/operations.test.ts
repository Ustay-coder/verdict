import { expect, it } from "vitest";
import { Engine } from "@verdict-ai/core";
import { compareSubjects, evaluateSubject } from "../src/operations.js";

const rubric = { name: "Test", criteria: [{ id: "a", name: "A", judge: { type: "benchmark", method: "regex", pattern: "hello" } }] };
const inputs = [{ type: "text" as const, text: "hello" }];

it("evaluates and replays directly without a server", async () => {
  const dependencies = { engine: new Engine() };
  const request = { rubric, inputs, idempotencyKey: "direct" };
  const first = await evaluateSubject(dependencies, request);
  const replay = await evaluateSubject(dependencies, request);
  expect(first.evaluation.aggregate.score).toBe(100);
  expect(replay).toMatchObject({ replayed: true, evaluation: { id: first.evaluation.id } });
  const comparison = await compareSubjects(dependencies, { rubric, subjects: [{ inputs }, { inputs: [{ type: "text", text: "absent" }] }] });
  expect(comparison.ranking.map(row => row.score)).toEqual([100, 0]);
});

it("reports a missing local dependency explicitly", async () => {
  await expect(evaluateSubject({}, { rubric, inputs })).rejects.toThrow("requires an engine");
  await expect(compareSubjects({}, { rubric, subjects: [] })).rejects.toThrow("requires an engine");
});
