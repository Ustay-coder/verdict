/**
 * Registers `verdict diff`: compare two rubric versions (or stored runs) on the same cases. Stored runs of a version
 * over the same inputs are reused unless --rerun; `--fail-on` turns the comparison into a CI gate.
 */
import { compareRuns, policyRescoreBlocker, rescoreRunUnder, runCases, ValidationError, type CaseClass, type Comparison, type DatasetVersion, type RubricVersion } from "@verdict-ai/core";
import { Command } from "commander";

import { rubricNameFor } from "../control/names.js";
import { addReportOptions, openReporter, ownAgreement, type Reporter, type ReportOptions } from "../control/report.js";
import { addServerRefOptions, resolveRef, serverRef } from "../control/server-ref.js";
import { withHub } from "../hub/deps.js";
import { renderComparison, renderComparisonMarkdown } from "../versions/render.js";
import { isRubricFile, latestRun, loadRun, resolveDataset, versionDefaults, workspace, type LoadedRun, type VersionDependencies, type Workspace } from "../versions/workspace.js";

interface DiffOptions extends ReportOptions { base: string; head: string; env?: string; data?: string; labels?: string; mock?: boolean; rerun?: boolean; failOn?: string; nearMargin?: string; json?: boolean; markdown?: boolean; title?: string; lock?: string }

const GATES = ["fixed", "regressed", "kept_miss", "changed_unlabelled", "escalated", "error", "missing", "incomparable", "near_boundary"] as const;

/** Registers diff; failures reach the CLI failure handler, a tripped gate only sets the exit code. */
export function registerDiff(program: Command, deps: VersionDependencies = versionDefaults) {
  const command = program.command("diff").description("compare two rubric versions or runs case by case (local engine)")
    .requiredOption("--base <ref>", "rubric file, rv_…, run_…, or a name on your team's server (<name> with --env, <name>@latest, <name>@rv_…)").requiredOption("--head <ref>", "the same")
    .option("-d, --data <file>", "gold cases to run on (required unless both refs are runs)")
    .option("--labels <file>", "score both sides against these labels instead (same inputs)")
    .option("--rerun", "run again even when a stored run of the same version and inputs exists")
    .option("--fail-on <classes>", `exit 1 when any case falls in these classes: ${GATES.join(", ")}`)
    .option("--near-margin <p>", "probability distance for near-boundary flags", "0.1")
    .option("--mock", "use mock providers for rubric files and versions").option("--lock <path>", "lock file", "verdict.lock").option("--json")
    .option("--markdown", "print GitHub-flavoured Markdown (PR comments, job summaries)").option("--title <text>", "Markdown heading", "Verdict diff")
    .option("--report", "report both runs and the comparison's counts to a project (no cases, inputs or outputs are sent)");
  addServerRefOptions(addReportOptions(command), false)
    .action(async (o: DiffOptions) => {
      const gates = parseGates(o.failOn);
      const nearMargin = Number(o.nearMargin);
      if (!(nearMargin > 0 && nearMargin < 1)) throw new ValidationError("--near-margin must be between 0 and 1");
      const ws = workspace(deps, o);
      const reporter = o.report ? await openReporter(withHub(deps), ws, o) : undefined;
      const dataset = o.data ? await resolveDataset(ws, o.data) : undefined;
      const base = await side(ws, o, o.base, dataset);
      const head = await side(ws, o, o.head, dataset, base);
      const labels = o.labels ? await resolveDataset(ws, o.labels) : dataset ?? (await requireDataset(ws, head.run.datasetVersionId));
      const comparison = compareRuns(base, head, labels, { nearMargin });
      if (o.json) deps.out(JSON.stringify(comparison, null, 2));
      else if (o.markdown) deps.out(renderComparisonMarkdown(comparison, o.title));
      else {
        for (const line of renderComparison(comparison)) deps.out(line);
        deps.warn(`see it in \`verdict watch\`: http://127.0.0.1:4600/compare?base=${base.run.id}&head=${head.run.id}&labels=${labels.id}`);
      }
      // Before the gate: a regression is what the team most needs to see on the server.
      if (reporter) await report(ws, reporter, o, { base, head, comparison });
      const tripped = trippedGates(comparison, gates);
      if (tripped.length) {
        deps.warn(`diff: ${tripped.map(([k, n]) => `${n} ${k}`).join(", ")} (--fail-on ${gates.join(",")})`);
        deps.exitCode(1);
      }
    });
}

/** Both runs, each scored against the labels it ran on, then the comparison's counts. Said on stderr. */
async function report(ws: Workspace, reporter: Reporter, o: DiffOptions, done: { base: LoadedRun; head: LoadedRun; comparison: Comparison }) {
  const file = (ref: string) => (isRubricFile(ref) ? ref : undefined);
  // A side named on the server says what the rubric is called there.
  const said = o.name ?? serverRef(o.head, o)?.name ?? serverRef(o.base, o)?.name;
  const name = await rubricNameFor(ws, said, [{ version: done.head.version, file: file(o.head) }, { version: done.base.version, file: file(o.base) }]);
  for (const loaded of [done.base, done.head]) {
    const { agreement, datasetName } = await ownAgreement(ws, loaded);
    ws.deps.warn(await reporter.run(name, loaded, agreement, datasetName));
  }
  ws.deps.warn(await reporter.comparison(name, done.comparison));
}

async function side(ws: Workspace, o: DiffOptions, ref: string, dataset: DatasetVersion | undefined, base?: LoadedRun): Promise<LoadedRun> {
  const { rerun } = o;
  if (ref.startsWith("run_")) return loadRun(ws, ref);
  if (!dataset) throw new ValidationError(`--data is required to run ${ref}`);
  const { version } = await resolveRef(ws, ref, o);
  const stored = rerun ? undefined : await latestRun(ws, version, dataset);
  if (stored) {
    ws.deps.warn(`reusing ${stored.id} (${stored.startedAt}) for ${version.id}; --rerun to run again`);
    return loadRun(ws, stored.id);
  }
  const rescored = !rerun && base ? await fromRecordedAnswers(ws, base, version, dataset) : undefined;
  if (rescored) return rescored;
  const { run, evaluations } = await runCases(ws.engine, version, dataset);
  await ws.store.putRun(run);
  return { run, version, evaluations };
}

/**
 * When `version` differs from the base only in how answers are read, re-score the base's recorded answers instead of
 * asking the judges again (docs/design/hub.md X3). Falls back to a real run, saying why, when replaying is not possible.
 */
async function fromRecordedAnswers(ws: Workspace, base: LoadedRun, version: RubricVersion, dataset: DatasetVersion): Promise<LoadedRun | undefined> {
  if (policyRescoreBlocker(base.version, version) || base.run.fingerprint.casesHash !== dataset.casesHash) return undefined;
  try {
    const { run, evaluations } = await rescoreRunUnder(ws.engine, base, version, dataset);
    await ws.store.putRun(run);
    ws.deps.warn(`${version.id} differs from ${base.version.id} only in policy: re-scored ${base.run.id}'s recorded answers (no judge calls); --rerun to ask the judges again`);
    return { run, version, evaluations };
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    ws.deps.warn(`${e.message}; running the cases instead`);
    return undefined;
  }
}

async function requireDataset(ws: Workspace, id: string): Promise<DatasetVersion> {
  const dataset = await ws.store.getDatasetVersion(id);
  if (!dataset) throw new ValidationError(`dataset ${id} is missing; pass --labels`);
  return dataset;
}

function parseGates(spec?: string): string[] {
  const gates = spec ? spec.split(",").map((g) => g.trim()).filter(Boolean) : [];
  const unknown = gates.filter((g) => !(GATES as readonly string[]).includes(g));
  if (unknown.length) throw new ValidationError(`unknown --fail-on class ${unknown.join(", ")}; use ${GATES.join(", ")}`);
  return gates;
}

function trippedGates(cmp: Comparison, gates: string[]): Array<[string, number]> {
  return gates.flatMap((g) => {
    const n = cmp.criteria.reduce((sum, c) => sum + (g === "near_boundary" ? c.counts.nearBoundary : c.counts[g as CaseClass]), 0);
    return n ? [[g, n] as [string, number]] : [];
  });
}
