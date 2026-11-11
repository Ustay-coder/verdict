/**
 * Registers the score command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { Command } from "commander";

import { commandDefaults, type CommandDependencies } from "../command-deps.js";
import { renderReport } from "../report.js";

/** Registers score operations; handler failures propagate to the transport error boundary. */
export function registerScore(program: Command, deps: CommandDependencies = commandDefaults) {
  program
    .command("score <evaluationId> <criterionId>")
    .description("submit a human score")
    .requiredOption("--rater <id>")
    .requiredOption("--score <value>", "number on the criterion scale, or a label")
    .option("--rationale <text>")
    .action(async (evaluationId: string, criterionId: string, o: ScoreOptions) => {
      const value = o.score.trim();
      // Empty values and non-finite numeric spellings cannot represent a score or label.
      if (!value || /^(?:[+-]?Infinity|NaN)$/i.test(value) || (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && !Number.isFinite(Number(value)))) return deps.fail("score must be a finite number or a non-empty scale label");
      const score = Number.isFinite(Number(value)) ? Number(value) : value;
      const api = deps.remote();
      const ev = api ? ((await api.evaluations.submitScore(evaluationId, { criterionId, raterId: o.rater, score, rationale: o.rationale }))) : await deps.engine().submitScore(evaluationId, { criterionId, raterId: o.rater, score, rationale: o.rationale });
      deps.out(renderReport(ev));
    });

}

interface ScoreOptions { score: string; rater: string; rationale?: string; }
