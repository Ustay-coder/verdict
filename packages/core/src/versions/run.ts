/**
 * Runs: one rubric version over one dataset version, with the conditions that make the result reproducible to
 * check (docs/design/hub.md §6). A run never overwrites another; re-running makes a new run. Re-scoring against a
 * newer label set reads stored ratings only and never calls a judge.
 */
import { agreementReport, caseSubjects, validateGoldLabels, type AgreementReport } from "../agreement.js";
import type { Engine } from "../engine.js";
import { fingerprint } from "../idempotency.js";
import { QUESTION_FORMAT_VERSION } from "../judges/decision/questions.js";
import type { Evaluation, Rating } from "../schema/evaluation.js";
import { ValidationError } from "../engine/errors.js";
import type { DatasetVersion } from "./dataset.js";
import type { RubricVersion } from "./rubric-version.js";

/** How agreement is decided (snap to the criterion scale, option ids for choices). Bump when that rule changes. */
export const SCORING_VERSION = "agreement@1";

/** A model that answered in a run. `verified` only when the provider's response named the model. */
export interface RunModel { provider: string; requested?: string; resolved?: string; verified: boolean }

/** Everything that has to match for two runs to differ only in the rubric. */
export interface RunFingerprint {
  judgmentHash: string; policyHash: string; bindingHash: string;
  /** Hash of the questions actually sent, per criterion, read back from the ratings; null without decision ratings. */
  questionsHash: string | null;
  adapterVersion: string;
  casesHash: string; labelsHash: string;
  models: RunModel[];
  scoring: string;
}

export interface RunCounts { cases: number; completed: number; pendingHuman: number; failed: number; invalidInput: number; labelled: number }

export interface Run {
  id: string;
  tenantId?: string;
  rubricVersionId: string;
  datasetVersionId: string;
  batchId?: string;
  /** `partial` when some cases failed or wait on a human; `failed` when every case failed. */
  status: "completed" | "partial" | "failed";
  fingerprint: RunFingerprint;
  cases: Array<{ caseId: string; evaluationId: string }>;
  counts: RunCounts;
  usage: { decisionCalls: number; llmCalls: number; inputTokens: number; outputTokens: number };
  /** Set when this run was re-scored from another run's recorded answers under a new policy: no judge was asked. */
  rescoredFrom?: string;
  startedAt: string;
  finishedAt: string;
}

export interface RunResult { run: Run; evaluations: Evaluation[]; report: AgreementReport }

/** Runs a version over a dataset as one batch. Unreadable labels are rejected before any judge runs. */
export async function runCases(engine: Engine, version: RubricVersion, dataset: DatasetVersion, opts: { tenantId?: string; now?: () => number } = {}): Promise<RunResult> {
  if (!dataset.cases.length) throw new ValidationError("the dataset has no cases");
  validateGoldLabels(version.rubric, dataset.cases);
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const { evaluations } = await engine.evaluateBatch(version.rubric, caseSubjects(dataset.cases), { tenantId: opts.tenantId });
  const run = await assembleRun(version, dataset, evaluations, { tenantId: opts.tenantId, startedAt, finishedAt: new Date(now()).toISOString() });
  return { run, evaluations, report: scoreRun(version, dataset, evaluations) };
}

/** The run record for evaluations of `version` over `dataset`, in case order. */
export async function assembleRun(version: RubricVersion, dataset: DatasetVersion, evaluations: Evaluation[], extra: { tenantId?: string; startedAt: string; finishedAt: string; rescoredFrom?: string }): Promise<Run> {
  return {
    id: `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
    ...(extra.tenantId ? { tenantId: extra.tenantId } : {}),
    rubricVersionId: version.id,
    datasetVersionId: dataset.id,
    ...(evaluations[0]?.batchId ? { batchId: evaluations[0].batchId } : {}),
    status: runStatus(evaluations),
    fingerprint: await runFingerprint(version, dataset, evaluations),
    cases: dataset.cases.map((c, i) => ({ caseId: c.id, evaluationId: evaluations[i]!.id })),
    counts: runCounts(dataset, evaluations),
    usage: sumUsage(evaluations),
    ...(extra.rescoredFrom ? { rescoredFrom: extra.rescoredFrom } : {}),
    startedAt: extra.startedAt,
    finishedAt: extra.finishedAt,
  };
}

/** Agreement of stored evaluations with a dataset's labels. Pure: never calls a judge. */
export function scoreRun(version: RubricVersion, dataset: DatasetVersion, evaluations: Evaluation[]): AgreementReport {
  const byCase = new Map(evaluations.map((e) => [e.subject.metadata?.caseId as string | undefined, e]));
  const pairs = dataset.cases.flatMap((item) => { const evaluation = byCase.get(item.id); return evaluation ? [{ item, evaluation }] : []; });
  return agreementReport(version.rubric, pairs);
}

/**
 * Re-scores a run against another label set without calling judges. Only labels may differ: when the inputs
 * changed, the stored answers are answers to other cases and the run has to be repeated instead.
 */
export function rescoreRun(version: RubricVersion, run: Run, labels: DatasetVersion, evaluations: Evaluation[]): AgreementReport & { labelsHash: string } {
  if (labels.casesHash !== run.fingerprint.casesHash) throw new ValidationError("the new dataset changes case inputs, not only labels; run the cases again");
  return { ...scoreRun(version, labels, evaluations), labelsHash: labels.labelsHash };
}

function runStatus(evaluations: Evaluation[]): Run["status"] {
  if (evaluations.every((e) => e.status === "failed")) return "failed";
  return evaluations.every((e) => e.status === "completed") ? "completed" : "partial";
}

function runCounts(dataset: DatasetVersion, evaluations: Evaluation[]): RunCounts {
  const count = (status: string) => evaluations.filter((e) => e.status === status).length;
  return {
    cases: evaluations.length, completed: count("completed"), pendingHuman: count("pending_human"), failed: count("failed"),
    invalidInput: evaluations.filter((e) => e.inputErrors?.length).length,
    labelled: dataset.cases.filter((c) => c.human.passed !== undefined || Object.keys(c.human.criteria ?? {}).length).length,
  };
}

function sumUsage(evaluations: Evaluation[]): Run["usage"] {
  const total = { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  for (const { usage } of evaluations) for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += usage[key];
  return total;
}

/**
 * What evaluations actually sent and who answered, read back from their ratings: the hash of the questions per
 * criterion (null without decision ratings) and the models. Lets `eval` compare a run with the one recorded in
 * verdict.lock without knowing anything else about it.
 */
export async function sentFingerprint(evaluations: Array<Pick<Evaluation, "criteria">>): Promise<{ questionsHash: string | null; models: RunModel[] }> {
  const ratings = evaluations.flatMap((e) => e.criteria.flatMap((c) => c.ratings.flatMap(withOriginal)));
  const questions = sentQuestions(ratings);
  return { questionsHash: Object.keys(questions).length ? await fingerprint(questions) : null, models: runModels(ratings) };
}

async function runFingerprint(version: RubricVersion, dataset: DatasetVersion, evaluations: Evaluation[]): Promise<RunFingerprint> {
  const sent = await sentFingerprint(evaluations);
  return {
    judgmentHash: version.judgmentHash, policyHash: version.policyHash, bindingHash: version.bindingHash,
    questionsHash: sent.questionsHash,
    adapterVersion: QUESTION_FORMAT_VERSION,
    casesHash: dataset.casesHash, labelsHash: dataset.labelsHash,
    models: sent.models,
    scoring: SCORING_VERSION,
  };
}

// An escalated rating keeps the decision rating it replaced; that rating is what the model actually answered.
function withOriginal(r: Rating): Rating[] {
  const original = r.judgeType === "human" && r.raw && "escalatedFrom" in r.raw ? r.raw.escalatedFrom : undefined;
  return original ? [r, original] : [r];
}

function sentQuestions(ratings: Rating[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const r of ratings) if (r.judgeType === "decision" && r.raw?.question && !(r.criterionId in questions)) questions[r.criterionId] = r.raw.question;
  return questions;
}

function runModels(ratings: Rating[]): RunModel[] {
  const seen = new Map<string, RunModel>();
  for (const r of ratings) {
    const model = ratingModel(r);
    if (model) seen.set(JSON.stringify(model), model);
  }
  return [...seen.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// LLM adapters do not yet tell a requested name from the one the response reported, so they stay unverified.
function ratingModel(r: Rating): RunModel | undefined {
  if (r.judgeType === "decision" && r.raw?.provider) {
    const raw = r.raw;
    // Ratings stored before requested and resolved models were split only have `model`; read it as requested.
    const requested = raw.modelVerified === undefined ? raw.model : raw.requestedModel;
    return { provider: raw.provider!, ...(requested ? { requested } : {}), ...(raw.resolvedModel ? { resolved: raw.resolvedModel } : {}), verified: raw.modelVerified === true };
  }
  if (r.judgeType === "llm" && r.raw) return { provider: r.raw.provider, ...(r.raw.model ? { requested: r.raw.model } : {}), verified: false };
  return undefined;
}
