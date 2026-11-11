/**
 * Duplicate in-process jobs share work; retryable attempts must not send terminal webhooks.
 */
import { RetryableError, type Job, type SerializableEvaluateRequest } from "../queue.js";
import type { Evaluation } from "../schema/evaluation.js";

import { EngineIdempotent } from "./idempotent.js";
import { initialEvaluation } from "./shared.js";
import { ConflictError, NotFoundError, transientErrors, ValidationError } from "./errors.js";
import { type EvaluateRequest } from "./types.js";

/** Schedules durable evaluations; rejects missing queues and uses RetryableError for transient attempts. */
export class EngineJobs extends EngineIdempotent {

  protected prepareQueued(ev: Evaluation) {
    ev.status = "queued";
    ev.job = { attempts: 0, maxAttempts: this.maxAttempts };
    ev.error = undefined;
    ev.updatedAt = new Date(this.now()).toISOString();
    return ev;
  }

  protected async enqueueDocument(ev: Evaluation): Promise<Evaluation> {
    if (!this.queue) throw new ValidationError("no queue configured");
    await this.store.putEvaluation(ev);
    // why: queue payloads must survive JSON transport; callbacks and AbortSignals cannot be serialized.
    const request: SerializableEvaluateRequest = { rubric: ev.rubric, subject: ev.subject, tenantId: ev.tenantId, metadata: ev.metadata, webhook: ev.webhook, idempotencyKey: ev.idempotencyKey };
    await this.queue.enqueue({ type: "evaluate", evaluationId: ev.id, request: JSON.parse(JSON.stringify(request)), attempt: 1 });
    return ev;
  }

  async enqueueEvaluation(req: EvaluateRequest): Promise<Evaluation> {
    if (!this.queue) throw new ValidationError("no queue configured");
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    return this.enqueueDocument(this.prepareQueued(initialEvaluation({ ...req, id: req.id ?? this.makeId("eval") }, rubric, rubricId, this.now)));
  }

  async enqueueEvaluationIdempotent(req: EvaluateRequest & { idempotencyKey: string }) {
    if (!this.queue) throw new ValidationError("no queue configured");
    const result = await this.runIdempotent(req, "evaluation", [req.subject], { after: ev => this.enqueueDocument(ev), prepare: ev => this.prepareQueued(ev) });
    return { evaluation: result.evaluations[0]!, replayed: result.replayed };
  }

  async evaluateBackground(req: EvaluateRequest, background: (work: Promise<unknown>) => void) {
    const start = async (ev: Evaluation) => {
      const work = this.evaluate({ ...req, rubric: ev.rubric, subject: ev.subject, id: ev.id });
      background(work);
      return ev;
    };
    if (req.idempotencyKey !== undefined) {
      const result = await this.runIdempotent({ ...req, idempotencyKey: req.idempotencyKey }, "evaluation", [req.subject], { after: start });
      return { evaluation: result.evaluations[0]!, replayed: result.replayed };
    }
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    const ev = initialEvaluation({ ...req, id: req.id ?? this.makeId("eval") }, rubric, rubricId, this.now);
    await this.store.putEvaluation(ev);
    return { evaluation: await start(ev), replayed: false };
  }

  async retryEvaluation(id: string, tenantId?: string): Promise<Evaluation> {
    const ev = await this.store.getEvaluation(id, tenantId);
    if (!ev) throw new NotFoundError(`evaluation ${id} not found`);
    if (ev.status !== "failed") throw new ConflictError("only failed evaluations can be retried");
    return this.enqueueDocument(this.prepareQueued(ev));
  }

  async processJob(job: Job): Promise<Evaluation> {
    if (job.type !== "evaluate") throw new ValidationError(`unknown job type: ${job.type}`);
    const jobs = this.locksForStore().jobs;
    const key = JSON.stringify([job.request.tenantId, job.evaluationId]);
    const active = jobs.get(key);
    // why: duplicate deliveries within this process share one attempt instead of charging judges twice.
    if (active) return active;
    const work = this.runJob(job);
    jobs.set(key, work);
    try { return await work; } finally { if (jobs.get(key) === work) jobs.delete(key); }
  }

  protected async runJob(job: Job): Promise<Evaluation> {
    const previous = await this.store.getEvaluation(job.evaluationId, job.request.tenantId);
    if (!previous) throw new NotFoundError(`evaluation ${job.evaluationId} not found`);
    // why: terminal or human-waiting documents must not be judged again on redelivery.
    if (previous.status === "completed" || previous.status === "pending_human" || previous.job?.deadLettered) return previous;
    if (previous.status === "failed" && !transientErrors(previous)) return previous;
    previous.job = { ...previous.job, attempts: job.attempt, maxAttempts: previous.job?.maxAttempts ?? this.maxAttempts, nextAttemptAt: undefined };
    const ev = await this.evaluate({ ...job.request, rubric: previous.rubric, subject: previous.subject, id: previous.id }, previous);
    const message = transientErrors(ev);
    if (message) await this.retryOrFail(ev, job, message);
    ev.job!.nextAttemptAt = undefined;
    await this.store.putEvaluation(ev);
    this.onEvent?.({ type: ev.status === "pending_human" ? "evaluation.pending_human" : ev.status === "failed" ? "evaluation.failed" : "evaluation.completed", evaluation: ev });
    if (ev.status === "completed" || ev.status === "failed") await this.deliverWebhook(ev);
    return ev;
  }

  private async retryOrFail(ev: Evaluation, job: Job, message: string): Promise<void> {
    ev.job!.lastError = message;
    // Publish retry state before requesting redelivery; only exhausted attempts send terminal webhooks.
    if (job.attempt < ev.job!.maxAttempts) {
      const delay = this.backoffMs(job.attempt);
      ev.job!.nextAttemptAt = new Date(this.now() + delay).toISOString();
      ev.status = "queued";
      await this.store.putEvaluation(ev);
      throw new RetryableError(message, delay);
    }
    ev.status = "failed";
    ev.job!.deadLettered = true;
    ev.error = message;
  }

}
