/**
 * Registers `verdict rescore`: score a stored run against a newer label set without calling any judge. Refuses when
 * the cases' inputs changed — then the stored answers belong to other cases.
 */
import { rescoreRun } from "@verdict-ai/core";
import { Command } from "commander";

import { renderAgreement } from "./check.js";
import { loadRun, resolveDataset, versionDefaults, workspace, type VersionDependencies } from "../versions/workspace.js";

/** Registers rescore; failures reach the CLI failure handler. */
export function registerRescore(program: Command, deps: VersionDependencies = versionDefaults) {
  program.command("rescore <runId>").description("score a stored run against new labels (no judge calls)")
    .requiredOption("-d, --data <file>", "gold cases with the new labels").option("--json")
    .action(async (runId: string, o: { data: string; json?: boolean }) => {
      const ws = workspace(deps);
      const { run, version, evaluations } = await loadRun(ws, runId);
      const labels = await resolveDataset(ws, o.data);
      const report = rescoreRun(version, run, labels, evaluations);
      if (o.json) { deps.out(JSON.stringify(report, null, 2)); return; }
      deps.out(`${run.id} re-scored against ${labels.id} (no judge calls)`);
      for (const line of renderAgreement(report)) deps.out(line);
    });
}
