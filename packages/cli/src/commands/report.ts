/**
 * Registers `verdict report`: send the numbers of a stored run to a project on a Verdict server, so the team sees
 * what was tested before a version is promoted. Only conditions and counts are sent — no case, input or answer.
 */
import { Command } from "commander";

import { rubricNameFor } from "../control/names.js";
import { addReportOptions, openReporter, ownAgreement, refuseMockRun, type ReportOptions } from "../control/report.js";
import { hubDefaults, type HubDependencies } from "../hub/deps.js";
import { loadRun, workspace } from "../versions/workspace.js";

/** Registers report; failures reach the CLI failure handler. */
export function registerReport(program: Command, deps: HubDependencies = hubDefaults) {
  addReportOptions(program.command("report <runId>").description("report a stored run's numbers to a project (no cases, inputs or outputs are sent)"))
    .option("--lock <path>", "lock file", "verdict.lock")
    .action(async (runId: string, o: ReportOptions & { lock?: string }) => {
      const ws = workspace(deps, o);
      const reporter = await openReporter(deps, ws, o);
      const loaded = await loadRun(ws, runId);
      refuseMockRun(loaded.run, loaded.version);
      const { agreement, datasetName } = await ownAgreement(ws, loaded);
      deps.out(await reporter.run(await rubricNameFor(ws, o.name, [loaded]), loaded, agreement, datasetName));
    });
}
