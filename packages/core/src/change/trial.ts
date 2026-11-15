/**
 * Trials: one candidate version put to a change test. A trial evaluates the same documents under the baseline and
 * the candidate, case by case, saving after every case so progress and partial results survive a reload. The engine
 * is given a rubric and a document and nothing else — no expectation, no other version's result. Verification reads
 * the stored evaluations afterwards. A trial is never changed once it ends: a retry or re-run is a new trial that
 * names the one it follows, and an evaluation shown again instead of made again is marked as reused.
 */
import { caseSubjects } from "../agreement.js";
import type { Engine } from "../engine.js";
import { NotFoundError, ValidationError } from "../engine/errors.js";
import { fingerprint } from "../idempotency.js";
import type { Evaluation } from "../schema/evaluation.js";
import type { DatasetVersion } from "../versions/dataset.js";
import type { RubricVersion } from "../versions/rubric-version.js";
import { sentFingerprint, type RunModel } from "../versions/run.js";
import { splitRubric } from "../versions/split.js";
import { observeSide } from "./observe.js";
import type { ChangeWorkbench } from "./store.js";
import { currentRevision, requireTest, type ChangeActor } from "./tests.js";
import type { ChangeTest, ExpectationRevision, SideObservation, Trial, TrialCase, TrialSide, TrialStatus, Verification } from "./types.js";
import { summarize, verifyCase } from "./verify.js";

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const iso = (now?: () => number) => new Date((now ?? Date.now)()).toISOString();
const ACTIVE: TrialStatus[] = ["queued", "running"];
const DEFAULT_CONCURRENCY = 4;

export interface TrialOptions extends ChangeActor {
  /** `retry` re-evaluates only what did not complete in the named trial; `rerun` evaluates everything again. */
  origin?: Trial["origin"];
  /** Show the baseline evaluations of an earlier trial of the same baseline instead of evaluating again (default true). */
  reuseBaseline?: boolean;
}

async function requireParts(store: ChangeWorkbench, test: ChangeTest, versionIds: string[], tenantId?: string) {
  const dataset = await store.getDatasetVersion(test.datasetVersionId, tenantId);
  if (!dataset) throw new ValidationError(`document set ${test.datasetVersionId} is missing`);
  const versions = await Promise.all(versionIds.map(async (id) => {
    const version = await store.getRubricVersion(id, tenantId);
    if (!version) throw new ValidationError(`no rubric version ${id} in this data directory`);
    return version;
  }));
  return { dataset, versions };
}

/** A completed evaluation of the same case and version in `source`, shown again and marked with where it came from. */
function reused(source: Trial | undefined, side: "baseline" | "candidate", versionId: string, caseId: string): TrialCase | undefined {
  if (!source || source[side].versionId !== versionId) return undefined;
  const entry = source[side].cases.find((c) => c.caseId === caseId && c.status === "completed" && c.evaluationId);
  return entry ? { caseId, status: "completed", evaluationId: entry.evaluationId, reusedFrom: entry.reusedFrom ?? source.id, ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}) } : undefined;
}

/** The work a trial would do: every case under both versions, queued unless an earlier evaluation is shown again. */
export async function planTrial(store: ChangeWorkbench, test: ChangeTest, candidateVersionId: string, opts: TrialOptions = {}): Promise<{ baseline: TrialSide; candidate: TrialSide; revision: ExpectationRevision; evaluations: number; reused: number }> {
  const revision = currentRevision(test);
  const { dataset } = await requireParts(store, test, [revision.baselineVersionId, candidateVersionId], opts.tenantId);
  const earlier = (await store.listTrials({ testId: test.id, tenantId: opts.tenantId })).filter((t) => !ACTIVE.includes(t.status));
  const followed = opts.origin && opts.origin.kind !== "new" ? earlier.find((t) => t.id === (opts.origin as { of: string }).of) : undefined;
  if (opts.origin && opts.origin.kind !== "new" && !followed) throw new NotFoundError(`trial ${opts.origin.of} not found`);
  const retry = opts.origin?.kind === "retry" ? followed : undefined;
  const fresh = opts.origin?.kind === "rerun" || opts.reuseBaseline === false;
  const side = (name: "baseline" | "candidate", versionId: string, sources: Array<Trial | undefined>): TrialSide => ({
    versionId,
    cases: dataset.cases.map((c) => sources.map((s) => reused(s, name, versionId, c.id)).find(Boolean) ?? { caseId: c.id, status: "queued" }),
  });
  const baseline = side("baseline", revision.baselineVersionId, fresh ? [] : retry ? [retry] : earlier);
  const candidate = side("candidate", candidateVersionId, retry ? [retry] : []);
  const all = [...baseline.cases, ...candidate.cases];
  return { baseline, candidate, revision, evaluations: all.filter((c) => c.status === "queued").length, reused: all.filter((c) => c.reusedFrom).length };
}

/**
 * Stores a queued trial. While a trial of the same test and candidate is queued or running, that one is returned
 * instead (`existing`), so a second click starts nothing.
 */
export async function createTrial(store: ChangeWorkbench, testId: string, candidateVersionId: string, opts: TrialOptions = {}): Promise<{ trial: Trial; existing: boolean }> {
  const test = await requireTest(store, testId, opts.tenantId);
  const active = (await store.listTrials({ testId, tenantId: opts.tenantId })).find((t) => ACTIVE.includes(t.status) && t.candidate.versionId === candidateVersionId);
  if (active) return { trial: active, existing: true };
  const plan = await planTrial(store, test, candidateVersionId, opts);
  const trial: Trial = {
    id: newId("trial"), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}), testId, revision: plan.revision.revision,
    baseline: plan.baseline, candidate: plan.candidate, status: "queued", origin: opts.origin ?? { kind: "new" }, verifications: [],
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}), createdAt: iso(opts.now),
  };
  await store.putTrial(trial);
  return { trial, existing: false };
}

export interface ExecuteOptions { tenantId?: string; signal?: AbortSignal; concurrency?: number; now?: () => number; runner?: string }

/** Evaluates every queued case, saving after each, then records the verification. Resolves with the finished trial. */
export async function executeTrial(engine: Engine, store: ChangeWorkbench, trialId: string, opts: ExecuteOptions = {}): Promise<Trial> {
  const trial = await requireTrial(store, trialId, opts.tenantId);
  if (trial.status !== "queued") throw new ValidationError(`trial ${trialId} is ${trial.status}; start a new trial instead`);
  const test = await requireTest(store, trial.testId, opts.tenantId);
  const { dataset, versions: [baseline, candidate] } = await requireParts(store, test, [trial.baseline.versionId, trial.candidate.versionId], opts.tenantId);
  let chain: Promise<void> = Promise.resolve();
  // One writer at a time: cases finish concurrently, and each save must hold everything finished so far.
  const save = () => (chain = chain.then(() => store.putTrial(structuredClone(trial))));
  trial.status = "running";
  trial.startedAt = iso(opts.now);
  if (opts.runner) trial.runner = opts.runner;
  await save();
  const subjects = new Map(caseSubjects(dataset.cases).map((subject, i) => [dataset.cases[i]!.id, subject]));
  const jobs = [...trial.baseline.cases.map((entry) => ({ entry, version: baseline! })), ...trial.candidate.cases.map((entry) => ({ entry, version: candidate! }))].filter((j) => j.entry.status === "queued");
  const next = jobs[Symbol.iterator]();
  const worker = async () => {
    for (const job of next) {
      await evaluateCase(engine, job.entry, job.version, subjects.get(job.entry.caseId)!, { ...opts, trialId, save });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY) }, worker));
  trial.status = finalStatus(trial, opts.signal?.aborted === true);
  trial.finishedAt = iso(opts.now);
  trial.verifications.push(await buildVerification(store, test, trial, { revision: trial.revision, kind: "after_run" }, opts));
  await save();
  return trial;
}

async function evaluateCase(engine: Engine, entry: TrialCase, version: RubricVersion, subject: ReturnType<typeof caseSubjects>[number], run: ExecuteOptions & { trialId: string; save: () => Promise<void> }) {
  if (run.signal?.aborted) { entry.status = "cancelled"; return; }
  entry.status = "running";
  entry.startedAt = iso(run.now);
  await run.save();
  try {
    // Only the rubric and the document go in: the engine cannot see what the test expects.
    const evaluation = await engine.evaluate({ rubric: version.rubric, subject, tenantId: run.tenantId, signal: run.signal, metadata: { changeTrial: run.trialId } });
    entry.evaluationId = evaluation.id;
    entry.status = evaluation.status !== "failed" ? "completed" : run.signal?.aborted ? "cancelled" : "failed";
    // A judge call cut short by a cancel comes back as a failed evaluation; it was cancelled, not refused by the judge.
    if (entry.status === "failed") entry.error = failureOf(evaluation);
  } catch (cause) {
    entry.status = run.signal?.aborted ? "cancelled" : "failed";
    entry.error = cause instanceof Error ? cause.message : String(cause);
  }
  entry.finishedAt = iso(run.now);
  await run.save();
}

/** Why an evaluation failed, down to what the judge said: "every criterion failed" alone names no cause. */
function failureOf(evaluation: Evaluation): string {
  const judge = evaluation.criteria.flatMap((c) => c.ratings).find((r) => r.error)?.error;
  const said = evaluation.error ?? "the evaluation failed";
  return judge && !said.includes(judge) ? `${said} (${judge})` : said;
}

function finalStatus(trial: Trial, cancelled: boolean): TrialStatus {
  const all = [...trial.baseline.cases, ...trial.candidate.cases];
  if (cancelled && all.some((c) => c.status === "cancelled")) return "cancelled";
  if (all.every((c) => c.status === "completed")) return "completed";
  return trial.candidate.cases.every((c) => c.status === "failed") ? "failed" : "partial";
}

export async function requireTrial(store: ChangeWorkbench, id: string, tenantId?: string): Promise<Trial> {
  const trial = await store.getTrial(id, tenantId);
  if (!trial) throw new NotFoundError(`trial ${id} not found`);
  return trial;
}

/** Ends a trial whose runner is gone: what was queued or running is cancelled, and finished cases stay as they are. */
export async function interruptTrial(store: ChangeWorkbench, trialId: string, reason: string, opts: ExecuteOptions = {}): Promise<Trial> {
  const trial = await requireTrial(store, trialId, opts.tenantId);
  if (!ACTIVE.includes(trial.status)) return trial;
  const test = await requireTest(store, trial.testId, opts.tenantId);
  for (const entry of [...trial.baseline.cases, ...trial.candidate.cases]) if (entry.status === "queued" || entry.status === "running") entry.status = "cancelled";
  trial.status = "cancelled";
  trial.error = reason;
  trial.finishedAt = iso(opts.now);
  trial.verifications.push(await buildVerification(store, test, trial, { revision: trial.revision, kind: "after_run" }, opts));
  await store.putTrial(trial);
  return trial;
}

/* ---- Reading a trial ---- */

export interface TrialCaseView { caseId: string; name: string; base: SideObservation; head: SideObservation; evaluations: { base?: Evaluation; head?: Evaluation } }
export interface TrialObservations { baseline: RubricVersion; candidate: RubricVersion; dataset: DatasetVersion; cases: TrialCaseView[] }

/** Both sides of every case, read from the stored evaluations. Never calls a judge. */
export async function observeTrial(store: ChangeWorkbench, test: ChangeTest, trial: Trial, tenantId?: string): Promise<TrialObservations> {
  const { dataset, versions: [baseline, candidate] } = await requireParts(store, test, [trial.baseline.versionId, trial.candidate.versionId], tenantId);
  const load = async (entry: TrialCase | undefined) => (entry?.evaluationId ? store.getEvaluation(entry.evaluationId, tenantId) : undefined);
  const cases = await Promise.all(dataset.cases.map(async (c) => {
    const b = trial.baseline.cases.find((x) => x.caseId === c.id) ?? { caseId: c.id, status: "cancelled" as const };
    const h = trial.candidate.cases.find((x) => x.caseId === c.id) ?? { caseId: c.id, status: "cancelled" as const };
    const [base, head] = await Promise.all([load(b), load(h)]);
    return { caseId: c.id, name: c.name, base: observeSide(baseline!, b, base), head: observeSide(candidate!, h, head), evaluations: { ...(base ? { base } : {}), ...(head ? { head } : {}) } };
  }));
  return { baseline: baseline!, candidate: candidate!, dataset, cases };
}

async function buildVerification(store: ChangeWorkbench, test: ChangeTest, trial: Trial, reading: { revision: number; kind: Verification["kind"] }, actor: ChangeActor): Promise<Verification> {
  const { revision: revisionNumber, kind } = reading;
  const revision = test.revisions.find((r) => r.revision === revisionNumber);
  if (!revision) throw new NotFoundError(`change test ${test.id} has no revision ${revisionNumber}`);
  if (revision.baselineVersionId !== trial.baseline.versionId) throw new ValidationError(`revision ${revisionNumber} measures from ${revision.baselineVersionId}, and this trial ran ${trial.baseline.versionId} as its baseline: start a new trial`);
  const seen = await observeTrial(store, test, trial, actor.tenantId);
  const ctx = { base: seen.baseline.rubric, head: seen.candidate.rubric, ...(test.mapping ? { mapping: test.mapping } : {}) };
  const judged = seen.cases.map((c) => ({ caseId: c.caseId, seen: { base: c.base, head: c.head }, verification: verifyCase(ctx, revision.cases[c.caseId] ?? [], { base: c.base, head: c.head }) }));
  return {
    id: `ver_${trial.verifications.length + 1}`, revision: revisionNumber, kind,
    cases: Object.fromEntries(judged.map((j) => [j.caseId, j.verification])), summary: summarize(judged),
    createdAt: iso(actor.now), ...(actor.createdBy ? { createdBy: actor.createdBy } : {}),
  };
}

/**
 * Reads a finished trial against another expectation revision (the newest by default) and appends the result. No
 * judge is asked: the stored evaluations are the same ones, and earlier verifications stay as they were written.
 */
export async function reverifyTrial(store: ChangeWorkbench, trialId: string, opts: ChangeActor & { revision?: number } = {}): Promise<Trial> {
  const trial = await requireTrial(store, trialId, opts.tenantId);
  if (ACTIVE.includes(trial.status)) throw new ValidationError(`trial ${trialId} is still ${trial.status}`);
  const test = await requireTest(store, trial.testId, opts.tenantId);
  const verification = await buildVerification(store, test, trial, { revision: opts.revision ?? currentRevision(test).revision, kind: "reverify" }, opts);
  const next: Trial = { ...trial, verifications: [...trial.verifications, verification] };
  await store.putTrial(next);
  return next;
}

/* ---- Conditions: what besides the rubric differed between the two sides ---- */

export interface ConditionDifference { field: "binding" | "models" | "modelsUnverified" | "extraction"; note: string; base?: unknown; head?: unknown; cases?: string[] }
export interface TrialConditions {
  /** True only when nothing but the rubric's judgment and policy can explain a difference. */
  rubricOnly: boolean;
  differences: ConditionDifference[];
  models: { base: RunModel[]; head: RunModel[] };
  /** Every answer came from a mock provider: nothing here is a model's judgement. */
  mock: boolean;
  /** A mock answered from a script written into the rubric's judge options. */
  scripted: boolean;
}

const modelKey = (m: RunModel) => `${m.provider}/${m.resolved ?? m.requested ?? ""}`;

export async function trialConditions(seen: TrialObservations): Promise<TrialConditions> {
  const evaluations = (side: "base" | "head") => seen.cases.flatMap((c) => (c.evaluations[side] ? [c.evaluations[side]!] : []));
  const [base, head] = await Promise.all([sentFingerprint(evaluations("base")), sentFingerprint(evaluations("head"))]);
  const differences: ConditionDifference[] = [];
  if (seen.baseline.bindingHash !== seen.candidate.bindingHash) differences.push({ field: "binding", note: "the judges' provider, model or options differ between the two versions" });
  const names = (models: RunModel[]) => models.map(modelKey).sort();
  if (base.models.length && head.models.length && names(base.models).join() !== names(head.models).join()) differences.push({ field: "models", note: "different models answered", base: names(base.models), head: names(head.models) });
  const unverified = [...base.models, ...head.models].filter((m) => !m.verified && m.provider !== "mock");
  if (unverified.length) differences.push({ field: "modelsUnverified", note: "the provider did not name the model that answered, so it cannot be confirmed to be the same on both sides", base: [...new Set(unverified.map(modelKey))] });
  const changed = await extractionDiffers(seen);
  if (changed.length) differences.push({ field: "extraction", note: "the text extracted from the document differs between the two sides", cases: changed });
  const all = [...base.models, ...head.models];
  const script = (v: RubricVersion) => JSON.stringify(splitRubric(v.rubric).binding).includes('"script"');
  return { rubricOnly: differences.length === 0, differences, models: { base: base.models, head: head.models }, mock: all.length > 0 && all.every((m) => m.provider === "mock"), scripted: script(seen.baseline) || script(seen.candidate) };
}

async function extractionDiffers(seen: TrialObservations): Promise<string[]> {
  const text = (e: Evaluation) => fingerprint(e.evidence.map((x) => x.text));
  const pairs = await Promise.all(seen.cases.map(async (c) => {
    const { base, head } = c.evaluations;
    return base && head && base.evidence.length && head.evidence.length && (await text(base)) !== (await text(head)) ? c.caseId : undefined;
  }));
  return pairs.filter((id): id is string => !!id);
}
