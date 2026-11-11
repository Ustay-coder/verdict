import type { Evaluation } from "../schema/evaluation.js";

/** Reports a missing tenant-visible resource with HTTP status 404. */
export class NotFoundError extends Error { status = 404; }
/** Reports invalid request semantics with HTTP status 400. */
export class ValidationError extends Error { status = 400; }

/** Reports incompatible resource state or idempotency reuse with HTTP status 409. */
export class ConflictError extends Error { status = 409; }


/** Returns the first retryable failure message, or undefined when no transient failure is recorded. */
export function transientErrors(ev: Evaluation): string | undefined {
  const errors = [ev.status === "failed" ? ev.error : undefined, ...ev.criteria.flatMap(c => c.ratings.filter(r => r.status === "error").map(r => r.error))].filter((e): e is string => !!e);
  return errors.find(e => /\b(429|5\d\d)\b|rate limit|timeout|timed out|fetch failed|ECONNRESET|ENOTFOUND|overloaded/i.test(e));
}
