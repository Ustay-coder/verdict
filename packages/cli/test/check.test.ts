import { expect, it, vi } from "vitest";
import { Command } from "commander";
import { Engine } from "@verdict-ai/core";
import { registerCheck } from "../src/commands/check.js";

// The mock decision provider answers binary questions with P=0.1 for "spam", 0.9 for "yes".
const rubric = { name: "Good message", defaultJudge: { type: "decision", provider: "mock" }, aggregation: { passThreshold: 50 },
  criteria: [{ id: "good", name: "Good", scale: { type: "binary", labels: ["no", "yes"] }, anchors: { no: "bad", yes: "good" } }] };
const gold = [
  { name: "a", inputs: [{ type: "text", text: "yes fine" }], human: { passed: true, criteria: { good: true } } },
  { name: "b", inputs: [{ type: "text", text: "spam that people liked" }], human: { passed: true } },
].map((g) => JSON.stringify(g)).join("\n");

function setup(remote?: object, goldText = gold, rubricDoc: object = rubric) {
  const out = vi.fn(), fail = vi.fn();
  const program = new Command();
  registerCheck(program, { engine: () => new Engine(), remote: () => remote as never, out, fail, loadRubric: async () => rubricDoc as never, readText: async () => goldText });
  return { out, fail, run: (...args: string[]) => program.parseAsync(args, { from: "user" }) };
}

it("prints agreement, per-criterion agreement and each disagreement", async () => {
  const { out, fail, run } = setup();
  await run("check", "-r", "rubric.yaml", "-g", "gold.jsonl");
  const lines = out.mock.calls.map((c) => String(c[0]));
  expect(lines[0]).toBe("Good message: 1/2 agree with the humans (50%); asked a human: 0; failed: 0");
  expect(lines[1]).toMatch(/good\s+1\/1 \(100%\)/);
  expect(lines[2]).toBe("  ✗ b: human pass, Verdict fail — spam that people liked");
  await run("check", "-r", "rubric.yaml", "-g", "gold.jsonl", "--json");
  expect(JSON.parse(String(out.mock.lastCall![0]))).toMatchObject({ decided: 2, agreed: 1 });
  expect(fail).not.toHaveBeenCalled();
});

it("refuses to run against a remote API", async () => {
  const { out, fail, run } = setup({});
  await run("check", "-r", "rubric.yaml", "-g", "gold.jsonl");
  expect(fail).toHaveBeenCalledWith(expect.stringMatching(/local engine/));
  expect(out).not.toHaveBeenCalled();
});

it("lists per-criterion disagreements and, when the gold set uses them, splits and label sources", async () => {
  const labelled = [
    { name: "c", inputs: [{ type: "text", text: "spam" }], expected: { good: "yes" }, split: "evaluation", labelSource: "ai_unreviewed" },
    { name: "d", inputs: [{ type: "text", text: "yes" }], expected: { good: "yes" }, split: "development", labelSource: "human" },
  ].map((g) => JSON.stringify(g)).join("\n");
  const { out, fail, run } = setup(undefined, labelled);
  await run("check", "-r", "rubric.yaml", "-g", "gold.jsonl");
  const lines = out.mock.calls.map((c) => String(c[0]));
  expect(lines).toContain("  splits: evaluation 0/0 (—) of 1; development 0/0 (—) of 1");
  expect(lines).toContain("  labels: ai_unreviewed 1, human 1");
  expect(lines).toContain("  ✗ c · good: human 1, Verdict 0 — spam");
  expect(fail).not.toHaveBeenCalled();
});

it("counts cases that fail the rubric's inputSchema apart and says why", async () => {
  const strict = { ...rubric, inputSchema: { type: "object", required: ["utterance"] } };
  const cases = [
    { name: "ok", inputs: [{ type: "json", data: { utterance: "yes" } }], expected: { good: "yes" } },
    { name: "bad", inputs: [{ type: "json", data: {} }], expected: { good: "yes" } },
  ].map((g) => JSON.stringify(g)).join("\n");
  const { out, run } = setup(undefined, cases, strict);
  await run("check", "-r", "rubric.yaml", "-g", "gold.jsonl");
  const lines = out.mock.calls.map((c) => String(c[0]));
  expect(lines[0]).toMatch(/failed: 1 \(invalid input: 1\)$/);
  expect(lines).toContain("  ! bad: invalid input — $.utterance is required");
});
