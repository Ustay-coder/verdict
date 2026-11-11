/**
 * Defines persisted evaluations, ratings and aggregate results.
 * Each evaluation freezes its rubric; raw criterion scores remain separate from normalized scores.
 */
import type { RatingRawByJudge } from "./rating-raw.js";
import type { Evidence, Subject } from "./subject.js";
import type { Rubric } from "./rubric.js";

export type RatingStatus = "scored" | "pending" | "error";

/** One judgement of one criterion by one rater (LLM sample, human, benchmark, ...). */
interface RatingFields {
  id: string;
  criterionId: string;
  raterId: string;
  status: RatingStatus;
  /** Selected option identifier for choice criteria. */
  choice?: string;
  /** Score in the criterion's own units (e.g. 0..10, or ordinal index). */
  score?: number;
  /** Score mapped to 0..1. */
  normalized?: number;
  /** Judge's own confidence 0..1 when available (decision models: distribution concentration). */
  confidence?: number;
  /** Probability per rubric level (decision models), keyed by level label. */
  probabilities?: Record<string, number>;
  rationale?: string;
  /** Quoted evidence supporting the score. */
  quotes?: string[];
  error?: string;
  createdAt: string;
}

/** judgeType selects the diagnostic payload without adding a discriminator to stored JSON. */
export type Rating<T extends keyof RatingRawByJudge = keyof RatingRawByJudge> = {
  [J in T]: RatingFields & { judgeType: J; raw?: RatingRawByJudge[J] }
}[T];

export interface CriterionResult {
  criterionId: string;
  name: string;
  weight: number;
  group?: string;
  status: "scored" | "pending" | "error" | "excluded";
  /** Aggregated across raters. */
  choice?: string;
  score?: number;
  normalized?: number;
  choices?: Record<string, number>;
  ratings: Rating[];
  /** Ratings still expected (e.g. human raters not yet submitted). */
  pending: number;
  gate?: { passed: boolean; message?: string };
}

export interface AggregateResult {
  method: string;
  /** Final score in the method's natural units (before normalization). */
  raw?: number;
  /** Final score on the configured output range (default 0..100). */
  score?: number;
  range: [number, number] | null;
  grade?: string;
  passed?: boolean;
  gates: Array<{ criterion: string; passed: boolean; message?: string }>;
  /** True when some criteria are still pending and the score is provisional. */
  partial: boolean;
  /** Which criteria were included in the total. */
  included: string[];
  excluded: string[];
}

export interface InputError { input: number | null; path: string; message: string }

export type EvaluationStatus = "queued" | "running" | "pending_human" | "completed" | "failed";

export interface Evaluation {
  job?: { attempts: number; maxAttempts: number; lastError?: string; nextAttemptAt?: string; deadLettered?: boolean };
  id: string;
  tenantId?: string;
  idempotencyKey?: string;
  rubricId?: string;
  /** Frozen snapshot — re-aggregation always uses this copy. */
  rubric: Rubric;
  subject: Subject;
  evidence: Evidence[];
  status: EvaluationStatus;
  criteria: CriterionResult[];
  aggregate: AggregateResult;
  /** Human tasks waiting on input. */
  pendingTasks: Array<{ criterionId: string; raterId?: string; allowedRaters?: string[]; instructions?: string }>;
  checks?: Array<{ id: string; probability: number | null; passed: boolean; action: "abort" | "fail" | "flag"; message?: string; error?: string }>;
  error?: string;
  /** Why the subject failed the rubric's `inputSchema` (evaluation `failed`, no judge called). `input` is the input index, null when no JSON input was given. */
  inputErrors?: InputError[];
  usage: { decisionCalls: number; llmCalls: number; inputTokens: number; outputTokens: number; durationMs: number };
  metadata?: Record<string, unknown>;
  webhook?: string;
  /** Shared by the evaluations of one batch (POST /v1/batches, `compare`). */
  batchId?: string;
  createdAt: string;
  updatedAt: string;
}
