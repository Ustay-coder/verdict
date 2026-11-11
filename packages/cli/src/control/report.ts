/**
 * Reporting runs to a project (docs/design/control-plane.md §7): `verdict report`, `run --report`, `diff --report`.
 * A report is built by core's request builders, which copy conditions and counts only; cases, inputs and answers stay
 * in the local data directory.
 */
import { comparisonReportRequest, runReportRequest, scoreRun, ValidationError, type AgreementReport, type Comparison, type ReportSource, type RubricVersion } from "@verdict-ai/core";
import type { Command } from "commander";

import type { HubDependencies } from "../hub/deps.js";
import type { LoadedRun, Workspace } from "../versions/workspace.js";
import { addTargetOptions, asking, controlTarget, type ControlTarget, type TargetOptions } from "./target.js";

export interface ReportOptions extends TargetOptions { report?: boolean; name?: string; commit?: string; branch?: string; runUrl?: string }

/** The options every reporting command takes. */
export function addReportOptions(command: Command): Command {
  return addTargetOptions(command)
    .option("--name <name>", "name the rubric is kept under on the server (default: verdict.lock, the rubric's id, its file name)")
    .option("--commit <sha>", "commit the run is of (default: GITHUB_SHA)").option("--branch <name>", "branch the run is of (default: GITHUB_HEAD_REF or GITHUB_REF_NAME)")
    .option("--run-url <url>", "link to the CI run (default: the GitHub Actions run)");
}

/** Where a run came from: flags first, then what GitHub Actions sets. Empty outside CI. */
export function reportSource(env: Record<string, string | undefined>, o: ReportOptions): ReportSource {
  const actions = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const source = { commit: o.commit ?? env.GITHUB_SHA, branch: o.branch ?? (env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME), url: o.runUrl ?? actions };
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v)) as ReportSource;
}

/** A run on mock providers says nothing about the rubric; it is never reported. */
export function refuseMockRun(run: { id: string }, version: RubricVersion): void {
  if (JSON.stringify(version.rubric).includes('"provider":"mock"')) throw new ValidationError(`run ${run.id} used mock providers; it is not reported`);
}

export interface Reporter {
  target: ControlTarget;
  /** Reports one run with its version; resolves to the line that says what happened. */
  run(name: string, loaded: Pick<LoadedRun, "run" | "version">, agreement: AgreementReport, datasetName?: string): Promise<string>;
  comparison(name: string, comparison: Comparison): Promise<string>;
}

/** Checks everything that can be checked before judges are paid for: the project, the server, and that the run is real. */
export async function openReporter(deps: HubDependencies, ws: Workspace, o: ReportOptions): Promise<Reporter> {
  if (ws.mock) throw new ValidationError("--mock runs are not reported: mock providers make it a run of another version");
  const target = await controlTarget(deps, o);
  const source = reportSource(deps.env, o);
  const where = `${target.project} on ${target.server}`;
  return {
    target,
    async run(name, { run, version }, agreement, datasetName) {
      refuseMockRun(run, version);
      const { created } = await asking(target, (client) => client.reports.run(target.project, runReportRequest(name, run, agreement, { datasetName, source, version })));
      return `${created ? "reported" : "already reported:"} ${run.id} (${name} at ${version.id}) ${created ? "to" : "in"} ${where}`;
    },
    async comparison(name, comparison) {
      const { report, created } = await asking(target, (client) => client.reports.comparison(target.project, comparisonReportRequest(name, comparison, source)));
      return `${created ? "reported" : "already reported:"} comparison ${report.id} (${comparison.kind}) ${created ? "to" : "in"} ${where}`;
    },
  };
}

/** A stored run's agreement with the labels it ran on, and that dataset's file name. */
export async function ownAgreement(ws: Workspace, loaded: LoadedRun): Promise<{ agreement: AgreementReport; datasetName?: string }> {
  const dataset = await ws.store.getDatasetVersion(loaded.run.datasetVersionId);
  if (!dataset) throw new ValidationError(`run ${loaded.run.id}'s dataset ${loaded.run.datasetVersionId} is missing from this data directory`);
  return { agreement: scoreRun(loaded.version, dataset, loaded.evaluations), datasetName: dataset.name };
}

