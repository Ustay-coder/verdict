import type { Evidence, Subject } from "./subject.js";
import type { Rubric } from "./rubric.js";

export type RatingStatus = "scored" | "pending" | "error";

/** One judgement of one criterion by one rater (LLM sample, human, benchmark, ...). */
export interface Rating {
  id: string;
  criterionId: string;
  raterId: string;
  judgeType: "llm" | "human" | "benchmark" | "panel";
  status: RatingStatus;
  /** Score in the criterion's own units (e.g. 0..10, or ordinal index). */
  score?: number;
  /** Score mapped to 0..1. */
  normalized?: number;
  /** Judge's own confidence 0..1 when available. */
  confidence?: number;
  rationale?: string;
  /** Quoted evidence supporting the score. */
  quotes?: string[];
  error?: string;
  /** Provider payloads, sub-sample scores, latency, cost, ... */
  raw?: Record<string, unknown>;
  createdAt: string;
}

export interface CriterionResult {
  criterionId: string;
  name: string;
  weight: number;
  group?: string;
  status: "scored" | "pending" | "error" | "excluded";
  /** Aggregated across raters. */
  score?: number;
  normalized?: number;
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

export type EvaluationStatus = "queued" | "running" | "pending_human" | "completed" | "failed";

export interface Evaluation {
  id: string;
  tenantId?: string;
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
  error?: string;
  usage: { llmCalls: number; inputTokens: number; outputTokens: number; durationMs: number };
  metadata?: Record<string, unknown>;
  webhook?: string;
  createdAt: string;
  updatedAt: string;
}
