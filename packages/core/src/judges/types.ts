/**
 * Defines the judge boundary and common evidence rendering.
 * Judges return pending or error ratings instead of throwing; raw and normalized scores remain distinct.
 */
import type { Criterion, Rubric, Scale } from "../schema/rubric.js";
import type { Evidence } from "../schema/subject.js";
import type { Rating } from "../schema/evaluation.js";

export interface JudgeContext {
  now?: () => number;
  newId?: (prefix: string) => string;
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

/** Allocates a rating identifier; requires the runtime random source. */
export function newRatingId(source?: Pick<JudgeContext, "now" | "newId">) {
  if (source?.newId) return source.newId("rat");
  return `rat_${Math.random().toString(36).slice(2, 10)}${(source?.now ?? Date.now)().toString(36)}`;
}

/** Creates common rating identity fields; does not invoke a judge or provider. */
export function ratingBase<T extends Rating["judgeType"]>(ctx: JudgeContext, judge: { id: string; type: T }, raterId = judge.id): { id: string; criterionId: string; raterId: string; judgeType: T; createdAt: string } {
  return { id: newRatingId(ctx), criterionId: ctx.criterion.id, raterId, judgeType: judge.type, createdAt: new Date((ctx.now ?? Date.now)()).toISOString() };
}

/** Render evidence into a single text block for prompt / HTTP judges. */
export function renderEvidence(evidence: Evidence[]): string {
  return evidence
    .map((e) => `<input index="${e.inputIndex}" label=${JSON.stringify(e.label)} kind="${e.kind}"${e.source ? ` source=${JSON.stringify(e.source)}` : ""}${e.truncated ? ' truncated="true"' : ""}>\n${e.text}\n</input>`)
    .join("\n\n");
}
