/**
 * Assembles the command tree without starting execution.
 * Importing the CLI must remain safe for tests and callers that supply their own argument vector.
 */
import { Command } from "commander";
import { registerCalibrate } from "./commands/calibrate.js";
import { registerCheck } from "./commands/check.js";
import { registerCompare } from "./commands/compare.js";
import { registerEvaluate } from "./commands/evaluate.js";
import { registerExport } from "./commands/export.js";
import { registerGet } from "./commands/get.js";
import { registerKeys } from "./commands/keys.js";
import { registerMcp } from "./commands/mcp.js";
import { registerReaggregate } from "./commands/reaggregate.js";
import { registerRetry } from "./commands/retry.js";
import { registerRubric } from "./commands/rubric.js";
import { registerScore } from "./commands/score.js";
import { registerServe } from "./commands/serve.js";
import { registerTasks } from "./commands/tasks.js";
import { registerWatch } from "./commands/watch.js";
import { registerVersion } from "./commands/version.js";
import { registerFork } from "./commands/fork.js";
import { registerRun } from "./commands/run.js";
import { registerDiff } from "./commands/diff.js";
import { registerRescore } from "./commands/rescore.js";
import { registerHub } from "./commands/hub.js";
import { registerPublish } from "./commands/publish.js";
import { registerPull } from "./commands/pull.js";
import { registerReport } from "./commands/report.js";
import { registerEnv, registerProject } from "./commands/project.js";
import { registerPromote } from "./commands/promote.js";

export { parseInput } from "./inputs.js";
export { mockify } from "./mock.js";
export { renderReport } from "./report.js";

/** Returns a configured command tree; command execution failures reject to the caller. */
export function buildCli() {
  const program = new Command().name("verdict").description("Evaluation engine: rubrics × judges (LLM / human / benchmark) × aggregation").version("0.1.0");
  registerRubric(program);
  registerEvaluate(program);
  registerCompare(program);
  registerCalibrate(program);
  registerCheck(program);
  registerVersion(program);
  registerFork(program);
  registerRun(program);
  registerDiff(program);
  registerRescore(program);
  registerHub(program);
  registerPublish(program);
  registerPull(program);
  registerReport(program);
  registerProject(program);
  registerEnv(program);
  registerPromote(program);
  registerGet(program);
  registerRetry(program);
  registerTasks(program);
  registerScore(program);
  registerReaggregate(program);
  registerServe(program);
  registerWatch(program);
  registerKeys(program);
  registerMcp(program);
  registerExport(program);
  return program;
}
