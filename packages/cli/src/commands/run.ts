/**
 * Registers `verdict run`: run one rubric version over one gold file and keep the run, so `verdict diff` can compare
 * it later without paying for it again.
 */
import { runCases } from "@verdict-ai/core";
import { Command } from "commander";

import { renderAgreement } from "./check.js";
import { rubricNameFor } from "../control/names.js";
import { addReportOptions, openReporter, type ReportOptions } from "../control/report.js";
import { addServerRefOptions, resolveRef } from "../control/server-ref.js";
import { withHub } from "../hub/deps.js";
import { lockKey, readLock, updateLock } from "../versions/lock.js";
import { renderRun } from "../versions/render.js";
import { resolveDataset, versionDefaults, workspace, type VersionDependencies } from "../versions/workspace.js";

interface RunOptions extends ReportOptions { rubric: string; data: string; env?: string; mock?: boolean; json?: boolean; lock?: string }

/** Registers run; failures reach the CLI failure handler. */
export function registerRun(program: Command, deps: VersionDependencies = versionDefaults) {
  const command = program.command("run").description("run a rubric version over a gold file and store the run (local engine)")
    .requiredOption("-r, --rubric <ref>", "rubric file, rv_… id, or a name on your team's server: <name> with --env, <name>@latest, <name>@rv_…").requiredOption("-d, --data <file>", "gold cases: JSON array or JSON lines")
    .option("--mock", "use mock providers (no API calls; a different version)").option("--lock <path>", "lock file", "verdict.lock").option("--json")
    .option("--report", "report the run's numbers to a project afterwards (no cases, inputs or outputs are sent)");
  addServerRefOptions(addReportOptions(command), false)
    .action(async (o: RunOptions) => {
      const ws = workspace(deps, o);
      // Opened before the run: a missing project or a mock run should not cost judge calls first.
      const reporter = o.report ? await openReporter(withHub(deps), ws, o) : undefined;
      const { version, file, name } = await resolveRef(ws, o.rubric, o);
      const dataset = await resolveDataset(ws, o.data);
      const result = await runCases(ws.engine, version, dataset);
      await ws.store.putRun(result.run);
      if (file && (await readLock(deps.lockIo, ws.lockPath)).rubrics[lockKey(ws.lockPath, file)]?.version === version.id) {
        const { id: runId, fingerprint: { questionsHash, models } } = result.run;
        await updateLock(deps.lockIo, ws.lockPath, file, (entry) => ({ ...entry, verified: { runId, questionsHash, models } }));
      }
      if (o.json) deps.out(JSON.stringify({ run: result.run, report: result.report }, null, 2));
      else for (const line of [...renderRun(result.run), ...renderAgreement(result.report)]) deps.out(line);
      // Said on stderr so --json output stays parseable.
      if (reporter) deps.warn(await reporter.run(await rubricNameFor(ws, o.name ?? name, [{ version, file }]), { run: result.run, version }, result.report, dataset.name));
    });
}
