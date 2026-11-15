/**
 * Change tests (docs/design/change-tests.md): a kept test says what a rubric change is meant to do to the judgement of
 * the same documents, and each trial checks one candidate version against it. Three layers stay apart everywhere:
 * whether an evaluation ran (execution), what could be judged (judgment), and whether that matches what the test
 * expected (verification). "Met" means the test's expectation held — never that a document passed or a rubric is right.
 */
import { z } from "zod";
import type { InfoRequest } from "../schema/rubric.js";

/** What could be judged. `abstained` covers an option marked `abstain` and a criterion handed to a person. */
export const JUDGMENT_STATES = ["scored", "needs_info", "abstained"] as const;
export type JudgmentState = (typeof JUDGMENT_STATES)[number];

/** Whether an expectation held. `needs_review`: a person has to decide; `incomparable`: there is nothing to compare. */
export const VERIFICATION_STATUSES = ["met", "unmet", "needs_review", "incomparable"] as const;
export type ExpectationStatus = (typeof VERIFICATION_STATUSES)[number];
/** A case adds `unverified`: no expectation was written for it, which is never a pass. */
export type CaseVerificationStatus = ExpectationStatus | "unverified";

/** Whether one evaluation of one case ran. `invalid_output`: it ran, and what it stored contradicts itself. */
export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TrialStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

/** Stated defaults: no tolerance, and "a change" means any amount above zero. Scores compare as stored, to 1e-9. */
export const CHANGE_DEFAULTS = { tolerance: 0, by: 0, epsilon: 1e-9 } as const;

const criterionId = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const base = {
  /** Stable within a revision; assigned when omitted. */
  id: z.string().min(1).max(40).optional(),
  /** The criterion (its id in the candidate) the expectation is about; omitted: the total. */
  criterion: criterionId.optional(),
  note: z.string().max(500).optional(),
};
const tolerance = z.number().min(0).default(CHANGE_DEFAULTS.tolerance);
const by = z.number().min(0).default(CHANGE_DEFAULTS.by);

/**
 * One checkable expectation about a case. Deltas (`hold`, `increase`, `decrease`, `not_lower`, `not_higher`) are
 * the candidate's score minus the baseline's; `range`, `state` and `asks_for` read the candidate alone.
 */
export const Expectation = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("hold"), tolerance }),
  z.object({ ...base, type: z.literal("increase"), by }),
  z.object({ ...base, type: z.literal("decrease"), by }),
  z.object({ ...base, type: z.literal("not_lower"), tolerance }),
  z.object({ ...base, type: z.literal("not_higher"), tolerance }),
  z.object({ ...base, type: z.literal("range"), min: z.number(), max: z.number() }),
  z.object({ ...base, type: z.literal("state"), state: z.enum(JUDGMENT_STATES) }),
  z.object({ ...base, type: z.literal("asks_for"), criterion: criterionId, fields: z.array(criterionId).min(1) }),
]).superRefine((e, ctx) => {
  if (e.type === "range" && e.min > e.max) ctx.addIssue({ code: "custom", path: ["max"], message: "max must not be below min" });
});
export type Expectation = z.infer<typeof Expectation> & { id: string };
export type ExpectationInput = z.input<typeof Expectation>;

/** The expectations of every case, as written at one time against one baseline. Never edited: a change is a new revision. */
export interface ExpectationRevision {
  revision: number;
  /** The version deltas are measured from. It stays while candidates change. */
  baselineVersionId: string;
  cases: Record<string, Expectation[]>;
  note?: string;
  createdAt: string;
  createdBy?: string;
}

export interface FollowUp { id: string; caseId: string; trialId: string; note?: string; createdAt: string; createdBy?: string; resolvedAt?: string }

export interface ChangeTest {
  id: string;
  tenantId?: string;
  name: string;
  /** What the change is meant to do, in the author's words. Shown to people; no judge and no verifier reads it. */
  intent: string;
  datasetVersionId: string;
  casesHash: string;
  /** The candidate picked when the test was written: what the setup screen shows beside the baseline. */
  candidateVersionId?: string;
  /** Candidate criterion id → baseline criterion id, for criteria whose id changed; null declares a new criterion. */
  mapping?: Record<string, string | null>;
  revisions: ExpectationRevision[];
  followUps: FollowUp[];
  history: Array<{ at: string; by?: string; action: "created" | "expectations_revised" | "baseline_changed" | "follow_up_added" | "follow_up_resolved"; detail?: string }>;
  /** Invented documents judged by a scripted mock (`verdict change-test demo`): never a real result. */
  demo?: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrialCase {
  caseId: string;
  status: ExecutionStatus;
  evaluationId?: string;
  error?: string;
  /** The trial whose evaluation is shown here instead of a new one; no judge was asked again. */
  reusedFrom?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TrialSide { versionId: string; cases: TrialCase[] }

export interface ExpectationResult {
  expectationId: string;
  status: ExpectationStatus;
  /** Machine-readable reason, e.g. `held`, `changed_beyond_tolerance`, `candidate_undetermined`, `scale_changed`. */
  code: string;
  /** The reason in words, with the numbers it rests on. */
  message: string;
  observed?: { base?: number | null; head?: number | null; delta?: number | null; state?: JudgmentState | null; fields?: string[] };
  /** True for totals whose make-up (criteria, weights) differs between the versions: the delta is real, its meaning shifted. */
  caveat?: string;
}

export interface CaseVerification { status: CaseVerificationStatus; expectations: ExpectationResult[] }

/** Three separate tallies. They are different classifications of the same cases and are not meant to be added up. */
export interface VerificationSummary {
  cases: number;
  execution: { evaluated: number; failed: number; unfinished: number };
  judgment: Record<JudgmentState, number> & { none: number; newlyNeedsInfo: number };
  verification: Record<CaseVerificationStatus, number> & { verifiable: number };
  expectations: Record<ExpectationStatus, number> & { total: number };
}

/** One reading of a trial against one expectation revision. Kept as written: later revisions never rewrite it. */
export interface Verification {
  id: string;
  revision: number;
  /** `reverify`: the expectations changed and stored evaluations were read again; no judge was asked. */
  kind: "after_run" | "reverify";
  cases: Record<string, CaseVerification>;
  summary: VerificationSummary;
  createdAt: string;
  createdBy?: string;
}

export interface Trial {
  id: string;
  tenantId?: string;
  testId: string;
  /** The expectation revision in force when the trial started. */
  revision: number;
  baseline: TrialSide;
  candidate: TrialSide;
  status: TrialStatus;
  /** A retry or re-run is a new trial that names the one it follows; the earlier one is never changed. */
  origin: { kind: "new" } | { kind: "retry" | "rerun"; of: string };
  verifications: Verification[];
  error?: string;
  /** Who is running it (e.g. `pid:4242`), so a trial left behind by a process that stopped can be told from a live one. */
  runner?: string;
  createdBy?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/* ---- What a stored evaluation says, read for comparison (observe.ts) ---- */

export interface QuoteLocation { inputIndex: number; label: string; line: number; start: number; end: number }
/** A quote a judge gave. `location` only when the text occurs in the document as extracted; otherwise it is not linked. */
export interface ObservedQuote { text: string; location?: QuoteLocation }

export interface CriterionObservation {
  criterionId: string;
  name: string;
  weight: number;
  /** `error`: the judge failed; `excluded`: a pre-screen check stopped the evaluation; `missing`: no result stored. */
  execution: "ok" | "error" | "excluded" | "missing";
  state: JudgmentState | null;
  /** In the criterion's own units; null whenever the judgement is open. Never coerced to zero. */
  score: number | null;
  range: [number, number];
  normalized: number | null;
  choice?: string;
  requests: InfoRequest[];
  /** Why the judgement is open, when it is. */
  reason?: string;
  rationale?: string;
  quotes: ObservedQuote[];
  /** Who judged: `llm mock`, `decision typesafe/jev-latest`, … */
  judges: string[];
  error?: string;
}

export interface TotalObservation {
  /** A number only when every criterion that counts was scored. */
  score: number | null;
  /** What the aggregation computed without the open criteria, shown as provisional and never compared. */
  provisional: number | null;
  range: [number, number] | null;
  /** Criteria that keep the total open, and the rubric's `aggregation.missing` policy that produced `provisional`. */
  openCriteria: string[];
  missingPolicy: "exclude" | "zero" | "fail";
  passed?: boolean;
  grade?: string;
}

export interface OutputIssue { code: string; message: string; criterionId?: string }

export interface SideObservation {
  /** `invalid_output`: an evaluation was stored and failed the output checks; nothing of it is read as a score. */
  execution: ExecutionStatus | "invalid_output";
  error?: string;
  issues: OutputIssue[];
  evaluationId?: string;
  reusedFrom?: string;
  state: JudgmentState | null;
  total: TotalObservation | null;
  criteria: CriterionObservation[];
}
