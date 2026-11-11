/**
 * Defines engine dependency injection, requests and observable lifecycle events.
 * Transport fingerprints preserve the original request while execution uses validated defaults.
 */
import { type IngestOptions } from "../ingest/index.js";
import { type Queue } from "../queue.js";
import type { CriterionResult, Evaluation } from "../schema/evaluation.js";
import { type Rubric } from "../schema/rubric.js";
import { Subject } from "../schema/subject.js";
import { type Store } from "../store/index.js";

export interface EngineOptions {
  /** Epoch milliseconds used for lifecycle timestamps and expiry. */
  now?: () => number;
  /** Generates opaque IDs; callers must return unique values. */
  newId?: (prefix: string) => string;
  /** Retry jitter source, in [0, 1). */
  random?: () => number;
  queue?: Queue;
  retry?: { maxAttempts?: number; backoffMs?: (attempt: number) => number };
  idempotencyTtlMs?: number;
  store?: Store;
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  ingest?: IngestOptions;
  /** Max criteria scored concurrently per evaluation. */
  concurrency?: number;
  /** Secret used to sign webhook deliveries (header `verdict-signature`). */
  webhookSecret?: string;
  onEvent?: (event: EngineEvent) => void;
}

export type EngineEvent =
  | { type: "webhook.failed"; evaluationId: string; error: string }
  | { type: "evaluation.started"; evaluation: Evaluation }
  | { type: "criterion.scored"; evaluationId: string; result: CriterionResult }
  | { type: "evaluation.completed"; evaluation: Evaluation }
  | { type: "evaluation.pending_human"; evaluation: Evaluation }
  | { type: "evaluation.failed"; evaluation: Evaluation };

export interface EvaluateRequest {
  idempotencyKey?: string;
  /** Original transport body, before defaults or shorthand expansion. */
  fingerprintBody?: unknown;
  /** Inline rubric or the id of a stored rubric. */
  rubric: Rubric | Record<string, unknown> | string;
  subject: Subject | Record<string, unknown>;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  /** POSTed with the final evaluation when it completes (also when humans finish it later). */
  webhook?: string;
  signal?: AbortSignal;
  /** Pre-assigned evaluation id (lets callers return it before the run finishes). */
  id?: string;
  /** Called as soon as the evaluation record exists in the store. */
  onStarted?: (evaluation: Evaluation) => void;
  /** Shared by every evaluation of one batch; set by evaluateBatch, so leaderboards can find their rows. */
  batchId?: string;
}

export interface ScoreSubmission {
  criterionId: string;
  raterId: string;
  /** Number on the criterion scale, or an ordinal / binary label. */
  score: number | string;
  rationale?: string;
  confidence?: number;
}

