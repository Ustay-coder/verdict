/**
 * Reporting runs and comparisons to the control plane (docs/design/control-plane.md §7). A report carries numbers
 * only. The request schemas have no field for a case id, an evaluation id, an input or an output, and the functions
 * that build a request copy the reported fields one by one, so nothing else leaves the machine that ran the cases.
 */
import { z } from "zod";
import type { AgreementReport } from "../agreement.js";
import { ValidationError } from "../engine/errors.js";
import { ReportedAgreement, ReportedRunNumbers, reportedNumbers, runNumbers } from "../hub/publication.js";
import { fingerprint } from "../idempotency.js";
import { COMPARISON_KINDS, type Comparison } from "../versions/compare.js";
import type { RubricVersion } from "../versions/rubric-version.js";
import type { Run } from "../versions/run.js";
import { VersionUpload } from "./requests.js";
import { CONTROL_NAME, type Actor, type ComparisonReport, type ProjectScope, type ProjectVersion, type ReportSource, type RunReport } from "./types.js";

const name = z.string().regex(CONTROL_NAME, "use lowercase letters, digits and dashes (up to 63 characters, not starting with a dash)");
const runId = z.string().regex(/^run_[0-9a-z]{1,40}$/, "expected a run id (run_…)");
const versionId = z.string().regex(/^rv_[0-9a-f]{20}$/, "expected a version id (rv_…)");
const count = z.number().int().min(0);
const rate = z.number().min(0).max(1).nullable();

const Source = z.object({ commit: z.string().max(100).optional(), branch: z.string().max(300).optional(), url: z.string().max(1000).optional() });
const Usage = z.object({ decisionCalls: count, llmCalls: count, inputTokens: count, outputTokens: count });

export const RunReportRequest = z.object({
  /** The rubric name the run's version is kept under. */
  name,
  run: ReportedRunNumbers.extend({ id: runId, rubricVersionId: versionId, usage: Usage.optional() }),
  report: ReportedAgreement,
  /** File name of the cases, to follow one dataset over time. */
  datasetName: z.string().max(200).optional(),
  source: Source.optional(),
  /** The run's version, when the server may not have it yet (a pull request's rubric). */
  version: VersionUpload.optional(),
});
export type RunReportRequest = z.input<typeof RunReportRequest>;

const Model = z.object({ provider: z.string(), requested: z.string().optional(), resolved: z.string().optional(), verified: z.boolean() });
/** A condition that differed: a hash, a version string, or the models that answered. */
const ConditionValue = z.union([z.string().max(300), z.null(), z.array(Model).max(50)]);
const Contract = z.object({
  type: z.enum(["score", "noul", "choice"]),
  levels: z.array(z.object({ value: z.number(), label: z.string().max(300) })).max(100).optional(),
  options: z.array(z.string().max(300)).max(200).optional(),
});
const Counts = z.object({
  kept_match: count, kept_miss: count, fixed: count, regressed: count, same_unlabelled: count, changed_unlabelled: count,
  escalated: count, error: count, missing: count, incomparable: count, cases: count, commonSucceeded: count, labelled: count, nearBoundary: count,
});
const Side = z.object({ runId, rubricVersionId: versionId });

export const ComparisonReportRequest = z.object({
  name,
  /** `compareRuns` without its per-case rows. */
  comparison: z.object({
    kind: z.enum(COMPARISON_KINDS),
    base: Side, head: Side,
    conditions: z.object({ same: z.boolean(), diffs: z.array(z.object({ field: z.string().max(60), base: ConditionValue, head: ConditionValue })).max(20) }),
    labels: z.object({ datasetVersionId: z.string().max(100), labelsHash: z.string().max(100), rescored: z.object({ base: z.boolean(), head: z.boolean() }) }),
    criteria: z.array(z.object({
      criterionId: z.string().max(200),
      contract: z.object({ same: z.boolean(), base: Contract, head: Contract }),
      counts: Counts,
      agreement: z.object({ n: count, base: rate, head: rate }),
    })).max(200),
  }),
  source: Source.optional(),
});
export type ComparisonReportRequest = z.input<typeof ComparisonReportRequest>;

/* ---------------- what a client sends ---------------- */

const present = <T extends object>(fields: T): Partial<T> => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;

export interface ReportExtras { datasetName?: string; source?: ReportSource; version?: RubricVersion }

/** The report of a run: its conditions and counts, copied field by field. Cases, evaluations and answers are not read. */
export function runReportRequest(rubricName: string, run: Run, report: AgreementReport, extras: ReportExtras = {}): RunReportRequest {
  const v = extras.version;
  const numbers = reportedNumbers(run, report);
  return {
    name: rubricName,
    run: { ...numbers.run, usage: { ...run.usage } },
    report: numbers.report,
    ...present({ datasetName: extras.datasetName, source: extras.source && Object.keys(present(extras.source)).length ? present(extras.source) : undefined }),
    ...(v ? { version: { id: v.id, rubric: v.rubric, ...present({ parentVersionId: v.parentVersionId, fork: v.fork }) } } : {}),
  };
}

/** The report of a comparison: counts per criterion. The per-case rows stay where the comparison was made. */
export function comparisonReportRequest(rubricName: string, c: Comparison, source?: ReportSource): ComparisonReportRequest {
  return {
    name: rubricName,
    comparison: {
      kind: c.kind, base: { ...c.base }, head: { ...c.head },
      conditions: { same: c.conditions.same, diffs: c.conditions.diffs.map((d) => ({ field: d.field, base: d.base, head: d.head })) as ComparisonReportRequest["comparison"]["conditions"]["diffs"] },
      labels: { datasetVersionId: c.labels.datasetVersionId, labelsHash: c.labels.labelsHash, rescored: { ...c.labels.rescored } },
      criteria: c.criteria.map((k) => ({ criterionId: k.criterionId, contract: k.contract, counts: { ...k.counts }, agreement: { ...k.agreement } })),
    },
    ...(source && Object.keys(present(source)).length ? { source: present(source) } : {}),
  };
}

/* ---------------- what a server keeps ---------------- */

export interface ReportContext { scope: ProjectScope; actor?: Actor; at: string }

const base = (ctx: ReportContext) => ({ ...(ctx.scope.tenantId === undefined ? {} : { tenantId: ctx.scope.tenantId }), project: ctx.scope.project });
const HASHES = ["judgmentHash", "policyHash", "bindingHash"] as const;

/** The stored report of a run. Throws unless the run is of `version` and names that version's hashes. */
export function runReport(request: z.output<typeof RunReportRequest>, version: ProjectVersion, ctx: ReportContext): RunReport {
  const { run } = request;
  if (run.rubricVersionId !== version.id) throw new ValidationError(`run ${run.id} is of ${run.rubricVersionId}, not ${version.id}`);
  const wrong = HASHES.find((h) => run.fingerprint[h] !== version[h]);
  if (wrong) throw new ValidationError(`run ${run.id} names another ${wrong} than version ${version.id} has; it was not a run of that version`);
  return {
    ...base(ctx), name: request.name, summary: runNumbers(run, request.report),
    ...present({ datasetName: request.datasetName, usage: run.usage, source: request.source, actor: ctx.actor }),
    reportedAt: ctx.at,
  };
}

/** The id of a comparison: the same two runs against the same labels are the same comparison. */
export async function comparisonId(c: Pick<Comparison, "base" | "head" | "labels">): Promise<string> {
  return `cmp_${(await fingerprint([c.base.runId, c.head.runId, c.labels.datasetVersionId, c.labels.labelsHash])).slice(0, 20)}`;
}

/** The stored report of a comparison. */
export async function comparisonReport(request: z.output<typeof ComparisonReportRequest>, ctx: ReportContext): Promise<ComparisonReport> {
  const { comparison } = request;
  return {
    ...base(ctx), id: await comparisonId(comparison), name: request.name, ...comparison,
    ...present({ source: request.source, actor: ctx.actor }),
    reportedAt: ctx.at,
  };
}
