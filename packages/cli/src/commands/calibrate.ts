/**
 * Registers the calibrate command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { calibrate } from "@verdict-ai/core";
import { Command } from "commander";

import { commandDefaults, type CommandDependencies } from "../command-deps.js";

/** Registers calibrate operations; handler failures propagate to the transport error boundary. */
export function registerCalibrate(program: Command, deps: CommandDependencies & { table: (rows: object[]) => void } = { ...commandDefaults, table: rows => console.table(rows) }) {
  program.command("calibrate <rubricId>").description("compare decision confidence with human scores")
    .option("--target <number>", "target agreement", "0.8").option("--buckets <number>", "confidence bins", "5").option("--json")
    .action(async (rubricId: string, o: CalibrateOptions) => {
      const options = { target: Number(o.target), buckets: Number(o.buckets) };
      // Reject invalid numbers before either transport can perform work.
      if (!o.target.trim() || !Number.isFinite(options.target) || options.target < 0 || options.target > 1) return deps.fail("target must be between 0 and 1");
      // Bucket counts bound report size and must describe whole bins.
      if (!Number.isInteger(options.buckets) || options.buckets < 1 || options.buckets > 1000) return deps.fail("buckets must be an integer between 1 and 1000");
      const api = deps.remote();
      const engine = api ? undefined : deps.engine();
      // Stored ids must resolve before scanning evaluation history.
      if (engine) await engine.resolveRubric(rubricId);
      const report = api ? await api.rubrics.calibration(rubricId, options)
        : calibrate(await engine!.store.listEvaluations({ rubricId, limit: 1000 }), options);
      // JSON output is machine-readable; table output is for interactive use.
      if (o.json) { deps.out(JSON.stringify(report, null, 2)); return; }
      deps.table([...report.criteria.map((c) => ({ criterion: c.criterionId, n: c.n, agreement: c.agreement, MAE: c.meanAbsError, ECE: c.ece, suggestedMinConfidence: c.suggestedMinConfidence })),
      { criterion: "overall", n: report.overall.n, agreement: report.overall.agreement, MAE: report.overall.meanAbsError, ECE: report.overall.ece, suggestedMinConfidence: report.overall.suggestedMinConfidence }]);
    });

}

interface CalibrateOptions { target: string; buckets: string; json?: boolean; }
