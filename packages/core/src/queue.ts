/**
 * Defines serializable jobs and an in-process retry queue.
 * Retryable failures retain attempt metadata; draining waits for outstanding work before shutdown.
 */
import type { Engine, EvaluateRequest } from "./engine.js";

export type SerializableEvaluateRequest = Pick<EvaluateRequest, "rubric" | "subject" | "tenantId" | "metadata" | "webhook" | "idempotencyKey">;
export interface Job { type: "evaluate"; evaluationId: string; request: SerializableEvaluateRequest; attempt: number }
export interface Queue { enqueue(job: Job, opts?: { delayMs?: number }): Promise<void> }
/** Requests queue retry with an optional backoff delay; terminal failures use ordinary errors. */
export class RetryableError extends Error {
  constructor(message: string, public retryAfterMs?: number) { super(message); this.name = "RetryableError"; }
}

/** In-process queue. Attach the engine after constructing both objects. */
export class MemoryQueue implements Queue {
  engine?: Pick<Engine, "processJob">;
  private active = 0;
  private delayed = 0;
  private ready: Job[] = [];
  private waiters: Array<() => void> = [];
  private concurrency: number;
  constructor(private opts: { engine?: Pick<Engine, "processJob">; concurrency?: number; onError?: (error: unknown) => void } = {}) {
    this.engine = opts.engine;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
  }
  async enqueue(job: Job, opts?: { delayMs?: number }): Promise<void> {
    // why: queued work is a snapshot; caller mutations after enqueue must not change the eventual request.
    const copy = structuredClone(job);
    if (opts?.delayMs && opts.delayMs > 0) {
      this.delayed++;
      const timer = setTimeout(() => { this.delayed--; this.ready.push(copy); this.pump(); }, opts.delayMs);
      // why: delayed retries must not keep an otherwise idle Node process alive; Workers timers have no unref.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    } else { this.ready.push(copy); queueMicrotask(() => this.pump()); }
  }
  drain(): Promise<void> {
    if (!this.active && !this.delayed && !this.ready.length) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
  private pump() {
    while (this.active < this.concurrency && this.ready.length) {
      const job = this.ready.shift()!;
      this.active++;
      void Promise.resolve().then(() => {
        if (!this.engine) throw new Error("MemoryQueue requires an engine");
        return this.engine.processJob(job);
      }).catch(async error => {
        // why: only explicit retry requests requeue; permanent failures are reported once to the error sink.
        if (error instanceof RetryableError) await this.enqueue({ ...job, attempt: job.attempt + 1 }, { delayMs: error.retryAfterMs });
        else (this.opts.onError ?? console.error)(error);
      }).finally(() => {
        this.active--; this.pump();
      });
    }
    if (!this.active && !this.delayed && !this.ready.length) this.waiters.splice(0).forEach(resolve => resolve());
  }
}
