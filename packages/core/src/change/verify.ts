/**
 * Compares what two versions said about a case with what the test expected. Pure and deterministic: it reads
 * observations (observe.ts) and never calls a judge or a model, and no generated explanation decides anything.
 * Each expectation is judged on its own; a score that is open is never compared as a number, while expectations
 * about the state or the question asked are still checked for the same case.
 */
import type { Criterion, Rubric } from "../schema/rubric.js";
import { counterpart, sameTotalMakeUp, type Counterpart } from "./criteria.js";
import {
  CHANGE_DEFAULTS, type CaseVerification, type CaseVerificationStatus, type CriterionObservation, type Expectation, type ExpectationResult,
  type ExpectationStatus, type JudgmentState, type SideObservation, type VerificationSummary,
} from "./types.js";

const EPS = CHANGE_DEFAULTS.epsilon;

export interface VerifyContext { base: Rubric; head: Rubric; mapping?: Record<string, string | null> }
export interface CaseObservations { base: SideObservation; head: SideObservation }

type Outcome = Omit<ExpectationResult, "expectationId">;
const outcome = (status: ExpectationStatus, code: string, message: string, extra: Partial<Outcome> = {}): Outcome => ({ status, code, message, ...extra });
const DELTA_TYPES = new Set(["hold", "increase", "decrease", "not_lower", "not_higher"]);

/** Every expectation of one case, each with its own result, and the case's status by the rule in `caseStatus`. */
export function verifyCase(ctx: VerifyContext, expectations: Expectation[], seen: CaseObservations): CaseVerification {
  const results = expectations.map((e) => ({ expectationId: e.id, ...verifyExpectation(ctx, e, seen) }));
  return { status: caseStatus(results), expectations: results };
}

/**
 * No expectation: unverified. Otherwise the worst result decides, in the order unmet, needs review, incomparable:
 * a case is met only when every one of its expectations is.
 */
export function caseStatus(results: ExpectationResult[]): CaseVerificationStatus {
  if (!results.length) return "unverified";
  for (const status of ["unmet", "needs_review", "incomparable"] as const) if (results.some((r) => r.status === status)) return status;
  return "met";
}

export function verifyExpectation(ctx: VerifyContext, e: Expectation, seen: CaseObservations): Outcome {
  const blocked = sideBlocked("candidate", seen.head);
  if (blocked) return blocked;
  // A target that is gone from the candidate is settled first: every kind of expectation about it has nothing to read.
  const gone = e.criterion && !ctx.head.criteria.some((c) => c.id === e.criterion) ? pairingProblem(e.criterion, counterpart(ctx.base, ctx.head, ctx.mapping, e.criterion)) : undefined;
  if (gone) return gone;
  if (e.type === "asks_for") return verifyAsksFor(ctx, e, seen.head);
  if (e.type === "state") return verifyState(e, seen.head);
  const head = scoreOf(ctx.head, seen.head, e.criterion);
  if ("status" in head) return head;
  if (e.type === "range") return verifyRange(e, head);
  return verifyDelta(ctx, e, seen, head);
}

function sideBlocked(side: "baseline" | "candidate", seen: SideObservation): Outcome | undefined {
  if (seen.execution === "completed") return undefined;
  if (seen.execution === "invalid_output") return outcome("incomparable", `${side}_invalid_output`, `the ${side}'s stored output failed validation: ${seen.issues[0]?.message ?? "see the case"}`);
  const why = seen.execution === "failed" ? `failed${seen.error ? `: ${seen.error}` : ""}` : `was ${seen.execution === "cancelled" ? "cancelled" : "not finished"}`;
  return outcome("incomparable", `${side}_${seen.execution}`, `the ${side} evaluation ${why}`);
}

interface Scored { score: number; range: [number, number] | null; label: string }
interface Open { open: true; state: JudgmentState | null; label: string; why: string; range: [number, number] | null }

/** The score an expectation is about on one side: a number, an open judgement, or the reason there is nothing to read. */
function scoreOf(rubric: Rubric, seen: SideObservation, criterionId: string | undefined): Scored | Open | Outcome {
  if (!criterionId) {
    const total = seen.total!;
    if (total.score === null) return { open: true, state: seen.state, label: "total", range: total.range, why: total.openCriteria.length ? `${total.openCriteria.join(", ")} ${total.openCriteria.length > 1 ? "are" : "is"} not scored` : "no total was computed" };
    return { score: total.score, range: total.range, label: "total" };
  }
  const observed = seen.criteria.find((c) => c.criterionId === criterionId);
  if (!observed) return outcome("incomparable", "criterion_missing", `criterion ${criterionId} is not in ${rubric.name}`);
  if (observed.execution !== "ok") return outcome("incomparable", `criterion_${observed.execution}`, `${criterionId} was not judged (${observed.error ?? observed.execution})`);
  if (observed.score === null) return { open: true, state: observed.state, label: criterionId, range: observed.range, why: openWhy(observed) };
  return { score: observed.score, range: observed.range, label: criterionId };
}

function openWhy(o: CriterionObservation): string {
  if (o.state === "needs_info") return "it asks for more information";
  if (o.state === "abstained") return `the judgement is withheld (${o.reason ?? "abstained"})`;
  return "its answer is a category without a score";
}

function verifyRange(e: Extract<Expectation, { type: "range" }>, head: Scored | Open): Outcome {
  if ("open" in head) return outcome("incomparable", "candidate_undetermined", `the candidate's ${head.label} has no score: ${head.why}`, { observed: { head: null, state: head.state } });
  const within = head.score >= e.min - EPS && head.score <= e.max + EPS;
  const wanted = e.min === e.max ? `${e.min}` : `${e.min}–${e.max}`;
  return outcome(within ? "met" : "unmet", within ? "in_range" : "out_of_range", `the candidate's ${head.label} is ${head.score}; expected ${wanted}`, { observed: { head: head.score } });
}

function verifyDelta(ctx: VerifyContext, e: Extract<Expectation, { type: "hold" | "increase" | "decrease" | "not_lower" | "not_higher" }>, seen: CaseObservations, head: Scored | Open): Outcome {
  const blocked = sideBlocked("baseline", seen.base);
  if (blocked) return blocked;
  const pair = e.criterion ? counterpart(ctx.base, ctx.head, ctx.mapping, e.criterion) : undefined;
  const unpaired = pair ? pairingProblem(e.criterion!, pair) : undefined;
  if (unpaired) return unpaired;
  const base = scoreOf(ctx.base, seen.base, pair && "baseId" in pair ? pair.baseId : undefined);
  if ("status" in base) return base;
  const observed = { base: "open" in base ? null : base.score, head: "open" in head ? null : head.score, delta: null as number | null };
  if ("open" in base) return outcome("incomparable", "baseline_undetermined", `the baseline's ${base.label} has no score to measure from: ${base.why}`, { observed });
  if ("open" in head) return outcome("incomparable", "candidate_undetermined", `the candidate's ${head.label} has no score: ${head.why}; a change in points cannot be measured`, { observed: { ...observed, state: head.state } });
  if (!sameRange(base.range, head.range)) return outcome("incomparable", "scale_changed", `the scale changed (${rangeText(base.range)} → ${rangeText(head.range)}): ${base.score} and ${head.score} are not on the same scale, so no difference is taken`, { observed });
  const caveat = !e.criterion && !sameTotalMakeUp(ctx.base, ctx.head) ? "the two totals are built from different criteria or weights" : undefined;
  return { ...deltaOutcome(e, base.score, head.score, head.label), ...(caveat ? { caveat } : {}) };
}

function pairingProblem(criterionId: string, pair: Counterpart): Outcome | undefined {
  if (pair.kind === "same" || pair.kind === "mapped") return undefined;
  if (pair.kind === "gone") {
    return pair.renamedTo.length
      ? outcome("needs_review", "mapping_unconfirmed", `${criterionId} is not in the candidate; ${pair.renamedTo.join(", ")} has the same name. Confirm the mapping in the test before this can be checked`)
      : outcome("incomparable", "criterion_removed", `${criterionId} is not in the candidate version`);
  }
  if (pair.kind === "unconfirmed") return outcome("needs_review", "mapping_unconfirmed", `${criterionId} is not in the baseline under that id; ${pair.candidates.join(", ")} has the same name. Confirm the mapping in the test before this can be checked`);
  return outcome("incomparable", "no_baseline_counterpart", `${criterionId} is new in the candidate: there is no baseline score to measure from`);
}

const sameRange = (a: [number, number] | null, b: [number, number] | null) => (a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1]);
const rangeText = (r: [number, number] | null) => (r ? `${r[0]}–${r[1]}` : "no fixed range");
const signed = (n: number) => `${n > 0 ? "+" : ""}${clean(n)}`;
// Trims float noise for messages only; every comparison uses the stored values.
const clean = (n: number) => String(Math.round(n * 1e6) / 1e6);

function deltaOutcome(e: Extract<Expectation, { type: "hold" | "increase" | "decrease" | "not_lower" | "not_higher" }>, base: number, head: number, label: string): Outcome {
  const delta = head - base;
  const observed = { base, head, delta };
  const moved = `${label} went ${clean(base)} → ${clean(head)} (${signed(delta)})`;
  const done = (ok: boolean, code: string, expected: string) => outcome(ok ? "met" : "unmet", ok ? code : `not_${code}`, `${moved}; expected ${expected}`, { observed });
  switch (e.type) {
    case "hold": return done(Math.abs(delta) <= e.tolerance + EPS, "held", e.tolerance ? `no change beyond ±${e.tolerance}` : "no change");
    case "increase": return done(delta > EPS && delta >= e.by - EPS, "increased", e.by ? `a rise of at least ${e.by}` : "a rise");
    case "decrease": return done(-delta > EPS && -delta >= e.by - EPS, "decreased", e.by ? `a drop of at least ${e.by}` : "a drop");
    case "not_lower": return done(delta >= -e.tolerance - EPS, "not_lower", e.tolerance ? `no drop beyond ${e.tolerance}` : "no drop");
    case "not_higher": return done(delta <= e.tolerance + EPS, "not_higher", e.tolerance ? `no rise beyond ${e.tolerance}` : "no rise");
  }
}

function verifyState(e: Extract<Expectation, { type: "state" }>, head: SideObservation): Outcome {
  let state: JudgmentState | null = head.state;
  let label = "the case";
  if (e.criterion) {
    const observed = head.criteria.find((c) => c.criterionId === e.criterion);
    if (!observed) return outcome("incomparable", "criterion_missing", `criterion ${e.criterion} is not in the candidate version`);
    if (observed.execution !== "ok") return outcome("incomparable", `criterion_${observed.execution}`, `${e.criterion} was not judged (${observed.error ?? observed.execution})`);
    state = observed.state; label = e.criterion;
  }
  const ok = state === e.state;
  return outcome(ok ? "met" : "unmet", ok ? "state_as_expected" : "state_differs", `${label} is ${stateText(state)}; expected ${stateText(e.state)}`, { observed: { state } });
}

const stateText = (s: JudgmentState | null) => (s === "needs_info" ? "needs information" : s === "abstained" ? "abstained" : s === "scored" ? "scored" : "not judged");

function verifyAsksFor(ctx: VerifyContext, e: Extract<Expectation, { type: "asks_for" }>, head: SideObservation): Outcome {
  const observed = head.criteria.find((c) => c.criterionId === e.criterion);
  if (!observed) return outcome("incomparable", "criterion_missing", `criterion ${e.criterion} is not in the candidate version`);
  if (observed.execution !== "ok") return outcome("incomparable", `criterion_${observed.execution}`, `${e.criterion} was not judged (${observed.error ?? observed.execution})`);
  const fields = observed.requests.map((r) => r.field);
  const seen = { state: observed.state, head: observed.score, fields };
  if (observed.state !== "needs_info") {
    const said = observed.state === "scored" ? `scored ${observed.score ?? observed.choice ?? "it"}` : `is ${stateText(observed.state)}`;
    return outcome("unmet", "not_asked", `${e.criterion} ${said} and asks nothing; expected a request for ${e.fields.join(", ")}`, { observed: seen });
  }
  const missing = e.fields.filter((f) => !fields.includes(f));
  if (missing.length) return outcome("unmet", "field_not_requested", `${e.criterion} asks for ${fields.join(", ") || "nothing"}; expected ${missing.join(", ")} as well`, { observed: seen });
  return askedAsDeclared(ctx.head.criteria.find((c) => c.id === e.criterion)!, e, observed, seen);
}

/**
 * A request counts as asking for a field when its question is the one the rubric version declares for that field.
 * Any other wording is left to a person: whether a free sentence asks for a fact is not decided here.
 */
function askedAsDeclared(criterion: Criterion, e: Extract<Expectation, { type: "asks_for" }>, observed: CriterionObservation, seen: NonNullable<Outcome["observed"]>): Outcome {
  const declared = Object.values(criterion.unresolved ?? {}).flatMap((o) => o.requests ?? []);
  const loose = e.fields.filter((field) => {
    const question = observed.requests.find((r) => r.field === field)?.question.trim();
    return !question || !declared.some((d) => d.field === field && d.question.trim() === question);
  });
  if (loose.length) return outcome("needs_review", "question_unverified", `${e.criterion} names ${loose.join(", ")}, but its question is not the one the rubric declares for that field: read the question and decide`, { observed: seen });
  const asked = e.fields.map((f) => `${f}: “${observed.requests.find((r) => r.field === f)!.question}”`).join("; ");
  return outcome("met", "asked", `${e.criterion} leaves the score open and asks for ${asked} (the rubric's question for that field)`, { observed: seen });
}

/** One score on both sides as a table or chart shows it. `delta` is null — never 0 — whenever it cannot be taken, with why. */
export interface ScoreChange { base: number | null; head: number | null; baseRange: [number, number] | null; headRange: [number, number] | null; delta: number | null; reason?: string }

/**
 * The change in the total (no `criterionId`) or in one criterion of the candidate, by the same rules the verifier
 * uses: no difference across an open score, a failed evaluation, an unmatched criterion or a changed scale.
 */
export function scoreChange(ctx: VerifyContext, seen: CaseObservations, criterionId?: string): ScoreChange {
  const pair = criterionId ? counterpart(ctx.base, ctx.head, ctx.mapping, criterionId) : undefined;
  const unpaired = pair ? pairingProblem(criterionId!, pair) : undefined;
  const head = sideBlocked("candidate", seen.head) ?? (pair?.kind === "gone" ? unpaired! : scoreOf(ctx.head, seen.head, criterionId));
  const base = sideBlocked("baseline", seen.base) ?? unpaired ?? scoreOf(ctx.base, seen.base, pair && "baseId" in pair ? pair.baseId : undefined);
  const read = (s: Scored | Open | Outcome) => ("status" in s ? { score: null, range: null, why: s.message } : "open" in s ? { score: null, range: s.range, why: `no ${s.label === "total" ? "total" : "score"}: ${s.why}` } : { score: s.score, range: s.range, why: undefined });
  const b = read(base), h = read(head);
  const out = { base: b.score, head: h.score, baseRange: b.range, headRange: h.range, delta: null };
  const reason = h.why ?? b.why ?? (sameRange(b.range, h.range) ? undefined : `the scale changed (${rangeText(b.range)} → ${rangeText(h.range)}), so no difference is taken`);
  return reason ? { ...out, reason } : { ...out, delta: h.score! - b.score! };
}

/** The three tallies of a verification. `verifiable` is the denominator of any agreement rate: met + unmet. */
export function summarize(cases: Array<{ seen: CaseObservations; verification: CaseVerification }>): VerificationSummary {
  const count = <T>(pick: (c: (typeof cases)[number]) => T, value: T) => cases.filter((c) => pick(c) === value).length;
  const done = (s: SideObservation) => s.execution === "completed";
  const broken = (s: SideObservation) => s.execution === "failed" || s.execution === "invalid_output";
  const results = cases.flatMap((c) => c.verification.expectations);
  const status = (s: CaseVerificationStatus) => count((c) => c.verification.status, s);
  const met = status("met"), unmet = status("unmet");
  return {
    cases: cases.length,
    execution: {
      evaluated: cases.filter((c) => done(c.seen.base) && done(c.seen.head)).length,
      failed: cases.filter((c) => broken(c.seen.base) || broken(c.seen.head)).length,
      unfinished: cases.filter((c) => !broken(c.seen.base) && !broken(c.seen.head) && !(done(c.seen.base) && done(c.seen.head))).length,
    },
    judgment: {
      scored: count((c) => c.seen.head.state, "scored"), needs_info: count((c) => c.seen.head.state, "needs_info"), abstained: count((c) => c.seen.head.state, "abstained"),
      none: count((c) => c.seen.head.state, null),
      newlyNeedsInfo: cases.filter((c) => c.seen.head.state === "needs_info" && c.seen.base.state !== "needs_info").length,
    },
    verification: { met, unmet, needs_review: status("needs_review"), incomparable: status("incomparable"), unverified: status("unverified"), verifiable: met + unmet },
    expectations: {
      total: results.length, met: results.filter((r) => r.status === "met").length, unmet: results.filter((r) => r.status === "unmet").length,
      needs_review: results.filter((r) => r.status === "needs_review").length, incomparable: results.filter((r) => r.status === "incomparable").length,
    },
  };
}

export const isDeltaExpectation = (e: Expectation) => DELTA_TYPES.has(e.type);
