/**
 * Evidence identity is part of batching; queued attempts defer terminal persistence and webhook delivery.
 */
import { aggregateCriteria, aggregateRatings, criterionScale } from "../aggregate/index.js";
import { ingest } from "../ingest/index.js";
import { buildJudge, DecisionJudge, type Judge, type JudgeContext, type SystemOneQuestion } from "../judges/index.js";
import type { CriterionResult, Evaluation, InputError, Rating } from "../schema/evaluation.js";
import { subjectInputErrors } from "./inputs.js";
import { type Criterion, type JudgeSpec, type Rubric } from "../schema/rubric.js";

import { ProviderError } from "../provider-error.js";
import { ValidationError } from "./errors.js";
import { runJudgeUnits, type JudgeUnit } from "./judging.js";
import { EngineBase } from "./base.js";
import { applyChecks, emptyAggregate, initialEvaluation } from "./shared.js";
import { type EvaluateRequest, type EngineOptions } from "./types.js";

// Judge construction is configured alongside the execution layer that owns it.
declare module "./types.js" {
  interface EngineOptions { judgeFactory?: typeof buildJudge }
}

/** Runs one evaluation; ingestion failures become failed documents and judge failures remain ratings. */
export class EngineRun extends EngineBase {
  protected judgeFactory: typeof buildJudge;

  constructor(opts: EngineOptions = {}) {
    super(opts);
    this.judgeFactory = opts.judgeFactory ?? buildJudge;
  }

  async evaluate(req: EvaluateRequest, queued?: Evaluation): Promise<Evaluation> {
    if (typeof req.rubric === "object" && Array.isArray(req.rubric.criteria) && !req.rubric.criteria.length) throw new ValidationError("rubric must contain at least one criterion");
    const started = this.now();
    const ev = await this.startEvaluation(req, queued);
    const inputErrors = subjectInputErrors(ev.rubric, ev.subject);
    if (inputErrors.length) return this.failInput(ev, inputErrors, started, queued);

    try {
      ev.evidence = await ingest(ev.subject, this.ingestOptions);
    } catch (e) {
      return this.failIngestion(ev, e, started, queued);
    }

    if (!ev.evidence.length || ev.evidence.every(item => !item.text.trim())) {
      const error = new ValidationError("evaluation evidence is empty after ingestion");
      // why: empty evidence is a terminal input error; preserve a failed document instead of leaving a running reservation.
      ev.status = "failed";
      ev.error = error.message;
      await this.finalizeEvaluation(ev, started);
      throw error;
    }

    if (await this.runChecks(ev, req)) return this.finalizeEvaluation(ev, started, queued);
    ev.criteria = await this.judgeCriteria(ev, req);
    this.finalize(ev);
    return this.finalizeEvaluation(ev, started, queued);
  }

  private async startEvaluation(req: EvaluateRequest, queued?: Evaluation): Promise<Evaluation> {
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    if (!rubric.criteria.length) throw new ValidationError("rubric must contain at least one criterion");
    const ev = initialEvaluation({ ...req, id: req.id ?? this.makeId("eval") }, rubric, rubricId, this.now);
    // why: queued attempts retain the original job identity until the queue owner persists the outcome.
    if (queued) { ev.job = { ...queued.job! }; ev.createdAt = queued.createdAt; ev.rubricId = queued.rubricId; if (queued.batchId) ev.batchId = queued.batchId; }
    await this.store.putEvaluation(queued ? structuredClone(ev) : ev);
    this.onEvent?.({ type: "evaluation.started", evaluation: ev });
    req.onStarted?.(ev);
    return ev;
  }

  // why: an input that breaks the rubric's contract is terminal; it fails before ingestion fetches anything or a judge is paid.
  private async failInput(ev: Evaluation, errors: InputError[], started: number, queued?: Evaluation) {
    ev.status = "failed";
    ev.inputErrors = errors;
    const first = errors[0]!;
    ev.error = `invalid input: ${first.path} ${first.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`;
    return this.finalizeEvaluation(ev, started, queued);
  }

  private async failIngestion(ev: Evaluation, cause: unknown, started: number, queued?: Evaluation) {
    ev.status = "failed";
    ev.error = `ingestion failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return this.finalizeEvaluation(ev, started, queued);
  }

  private async runChecks(ev: Evaluation, req: EvaluateRequest): Promise<boolean> {
    const rubric = ev.rubric;
    if (!rubric.checks?.length) return false;
    const judge = this.judgeFactory(rubric.checksJudge ?? rubric.defaultJudge, rubric) as DecisionJudge;
    const criterion = rubric.criteria[0]!;
    const ctx = this.contextFor(ev, criterion, req);
    const questions: Record<string, SystemOneQuestion> = Object.fromEntries(rubric.checks.map(c => [c.id, { type: "noul", instructions: c.question, criteria: c.criteria }]));
    try {
      const res = await judge.ask(ctx, questions);
      ev.checks = rubric.checks.map(c => {
        // why: missing or malformed probabilities fail closed rather than passing an admission check.
        const probability = res.answers[c.id]?.noul;
        if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return { id: c.id, probability: null, passed: false, action: c.action, message: c.message, error: `invalid answer for check ${c.id}` };
        return { id: c.id, probability, passed: (probability >= c.threshold) === c.expect, action: c.action, message: c.message };
      });
    } catch (e) {
      // why: stored check errors retain their original transport message for existing consumers.
      const error = this.checkFailureMessage(e);
      ev.checks = rubric.checks.map(c => ({ id: c.id, probability: null, passed: false, action: c.action, message: c.message, error }));
    }
    // why: abort checks exclude criteria without spending provider calls, but still produce a completed policy result.
    if (ev.checks.some(c => !c.passed && c.action === "abort")) {
      ev.criteria = rubric.criteria.map(c => ({ criterionId: c.id, name: c.name, weight: c.weight, group: c.group, status: "excluded", ratings: [], pending: 0 }));
      ev.aggregate = { ...emptyAggregate(rubric), partial: false, passed: false, excluded: rubric.criteria.map(c => c.id) };
      ev.status = "completed";
      ev.error = ev.checks.find(c => c.action === "abort" && c.error)?.error;
      applyChecks(ev);
      return true;
    }
    return false;
  }

  private checkFailureMessage(cause: unknown): string {
    // Check documents keep the original diagnostic while provider ratings retain operation context.
    while (cause instanceof ProviderError && cause.cause instanceof Error) cause = cause.cause;
    return cause instanceof Error ? cause.message : String(cause);
  }

  private async judgeCriteria(ev: Evaluation, req: EvaluateRequest): Promise<CriterionResult[]> {
    const rubric = ev.rubric;
    const ratingsByCriterion = new Map<string, Rating[]>();
    const expected = new Map<string, number>();

    // Evidence identity belongs in the batch key: criteria scoped to different inputs cannot share state.
    const units: JudgeUnit[] = [];
    for (const criterion of rubric.criteria) {
      const judges = this.judgesFor(rubric, criterion);
      expected.set(criterion.id, judges.reduce((s, j) => s + j.expectedRatings(), 0));
      ratingsByCriterion.set(criterion.id, []);
      const evidence = criterion.inputs?.length ? ev.evidence.filter((e) => e.tags.some((t) => criterion.inputs!.includes(t)) || criterion.inputs!.includes(e.label)) : ev.evidence;
      for (const judge of judges) {
        units.push({ criterion, judge, ctx: this.contextFor(ev, criterion, req, evidence) });
      }
    }
    await runJudgeUnits(units, ratingsByCriterion, this.concurrency);
    for (const criterion of rubric.criteria) {
      this.onEvent?.({ type: "criterion.scored", evaluationId: ev.id, result: aggregateRatings(rubric, criterion, ratingsByCriterion.get(criterion.id)!, expected.get(criterion.id)!) });
    }

    return rubric.criteria.map((c) => aggregateRatings(rubric, c, ratingsByCriterion.get(c.id) ?? [], expected.get(c.id) ?? 0));
  }

  private contextFor(ev: Evaluation, criterion: Criterion, req: EvaluateRequest, evidence = ev.evidence): JudgeContext {
    return { now: this.now, newId: this.makeId, rubric: ev.rubric, criterion, scale: criterionScale(ev.rubric, criterion), evidence, evaluationId: ev.id, env: this.env, fetch: this.fetchImpl, signal: req.signal, usage: ev.usage };
  }

  private async finalizeEvaluation(ev: Evaluation, started: number, queued?: Evaluation): Promise<Evaluation> {
    ev.usage.durationMs = this.now() - started;
    ev.updatedAt = new Date(this.now()).toISOString();
    if (!queued) await this.store.putEvaluation(ev);
    if (!queued) this.onEvent?.({ type: ev.status === "pending_human" ? "evaluation.pending_human" : ev.status === "failed" ? "evaluation.failed" : "evaluation.completed", evaluation: ev });
    if (!queued && (ev.status === "completed" || ev.status === "failed")) await this.deliverWebhook(ev);
    return ev;
  }


  protected judgesFor(rubric: Rubric, c: Criterion): Judge[] {
    const specs: JudgeSpec[] = Array.isArray(c.judge) ? c.judge : c.judge ? [c.judge] : [rubric.defaultJudge];
    return specs.map((s) => this.judgeFactory(s, rubric));
  }

  protected finalize(ev: Evaluation) {
    ev.aggregate = aggregateCriteria(ev.rubric, ev.criteria);
    applyChecks(ev);
    ev.pendingTasks = ev.criteria.flatMap((c) =>
      c.ratings.filter((r): r is Rating<"human"> => r.status === "pending" && r.judgeType === "human").map((r) => ({ criterionId: c.criterionId, raterId: /#\d+$/.test(r.raterId) ? undefined : r.raterId, allowedRaters: r.raw?.allowedRaters?.length ? r.raw.allowedRaters : undefined, instructions: r.raw?.instructions })),
    );
    const anyPending = ev.criteria.some((c) => c.status === "pending");
    // why: individual judge failures retain successful ratings; only universal failure makes the evaluation fail.
    const allErrored = ev.criteria.length > 0 && ev.criteria.every((c) => c.status === "error");
    ev.status = allErrored ? "failed" : anyPending ? "pending_human" : "completed";
    if (allErrored) ev.error = "every criterion failed to score";
    ev.updatedAt = new Date(this.now()).toISOString();
  }
}
