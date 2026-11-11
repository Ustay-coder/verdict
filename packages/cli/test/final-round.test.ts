import { expect, it, vi } from "vitest";
import { Command } from "commander";
import { Engine } from "@verdict-ai/core";
import { registerCalibrate } from "../src/commands/calibrate.js";
import { registerScore } from "../src/commands/score.js";

it("validates calibration and score options before calling injected transports", async () => {
  const engine = new Engine();
  const deps = { engine: vi.fn(() => engine), remote: vi.fn(() => undefined), out: vi.fn(), table: vi.fn(), fail: vi.fn() };
  const program = new Command();
  registerCalibrate(program, deps); registerScore(program, deps);
  const run = (...args: string[]) => program.parseAsync(args, { from: "user" });
  await run("calibrate", "unused", "--target", "NaN");
  expect(deps.fail).toHaveBeenLastCalledWith("target must be between 0 and 1");
  await run("calibrate", "unused", "--buckets", "1.5");
  expect(deps.fail).toHaveBeenLastCalledWith("buckets must be an integer between 1 and 1000");
  for (const score of ["", "NaN", "Infinity", "1e999"]) await run("score", "unused", "a", "--rater", "alice", "--score", score);
  expect(deps.remote).not.toHaveBeenCalled();
  const rubric = await engine.createRubric({ name: "Human", defaultJudge: { type: "human", raters: ["alice"] }, criteria: [{ id: "a", name: "A" }] });
  const evaluation = await engine.evaluate({ rubric: rubric.id, subject: { inputs: [{ type: "text", text: "hello" }] } });
  await run("score", evaluation.id, "a", "--rater", "alice", "--score", "3");
  expect(deps.out).toHaveBeenLastCalledWith(expect.stringContaining("completed"));
  await run("calibrate", rubric.id, "--json");
  expect(JSON.parse(deps.out.mock.lastCall![0]).overall).toBeDefined();
  await run("calibrate", rubric.id);
  expect(deps.table).toHaveBeenCalledOnce();
});
