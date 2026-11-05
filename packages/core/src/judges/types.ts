import type { Criterion, Rubric, Scale } from "../schema/rubric.js";
import type { Evidence } from "../schema/subject.js";
import type { Rating } from "../schema/evaluation.js";

export interface JudgeContext {
  rubric: Rubric;
  criterion: Criterion;
  scale: Scale;
  /** Evidence visible to this criterion (already filtered by criterion.inputs). */
  evidence: Evidence[];
  evaluationId: string;
  /** Resolve env vars / secrets. Defaults to process.env. */
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  signal?: AbortSignal;
  usage: { decisionCalls: number; llmCalls: number; inputTokens: number; outputTokens: number };
}

/** A judge produces one or more ratings for a criterion. Pending ratings mean "waiting on a human". */
export interface Judge {
  readonly id: string;
  readonly type: Rating["judgeType"];
  /** Number of ratings this judge is expected to eventually produce. */
  expectedRatings(): number;
  rate(ctx: JudgeContext): Promise<Rating[]>;
  /**
   * Optional: answer several criteria that share the same evidence in ONE call (decision models fan out
   * every question over one `state`). Keyed by criterion id. The engine groups by `batchKey()`.
   */
  rateMany?(ctxs: JudgeContext[]): Promise<Map<string, Rating[]>>;
  /** Judges with equal batch keys and equal evidence are batched together. */
  batchKey?(): string;
}

export function newRatingId() {
  return `rat_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function ratingBase(ctx: JudgeContext, judge: Judge, raterId = judge.id): Omit<Rating, "status"> {
  return { id: newRatingId(), criterionId: ctx.criterion.id, raterId, judgeType: judge.type, createdAt: new Date().toISOString() };
}

/** Render evidence into a single text block for prompt / HTTP judges. */
export function renderEvidence(evidence: Evidence[]): string {
  return evidence
    .map((e, i) => `<input index="${e.inputIndex}" label=${JSON.stringify(e.label)} kind="${e.kind}"${e.source ? ` source=${JSON.stringify(e.source)}` : ""}${e.truncated ? ' truncated="true"' : ""}>\n${e.text}\n</input>`)
    .join("\n\n");
}
