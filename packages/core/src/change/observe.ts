/**
 * Reads a stored evaluation for comparison: per criterion the score in its own units (null whenever the judgement
 * is open), the judgment state, what is asked for, the judge's reason and its quotes tied to the document. Pure.
 * The evaluation is checked first (`inspectOutput`): one that contradicts itself is reported as invalid output and
 * none of it is read as a score — nothing is repaired on the way in.
 */
import { criterionScale, scaleRange } from "../aggregate/index.js";
import type { CriterionResult, Evaluation, Rating, UnresolvedResult } from "../schema/evaluation.js";
import type { Criterion, Rubric } from "../schema/rubric.js";
import type { RubricVersion } from "../versions/rubric-version.js";
import { observeQuotes } from "./evidence.js";
import { CHANGE_DEFAULTS, type CriterionObservation, type JudgmentState, type OutputIssue, type SideObservation, type TotalObservation, type TrialCase } from "./types.js";

const EPS = CHANGE_DEFAULTS.epsilon;

/** One side of one case: how the evaluation went and, when it can be trusted, what it says. */
export function observeSide(version: RubricVersion, entry: TrialCase, evaluation: Evaluation | undefined): SideObservation {
  const meta = { ...(entry.evaluationId ? { evaluationId: entry.evaluationId } : {}), ...(entry.reusedFrom ? { reusedFrom: entry.reusedFrom } : {}) };
  const none = { issues: [], state: null, total: null, criteria: [], ...meta };
  if (entry.status !== "completed") return { ...none, execution: entry.status, ...(entry.error ? { error: entry.error } : {}) };
  if (!evaluation) return { ...none, execution: "failed", error: `evaluation ${entry.evaluationId ?? "?"} is not in this data directory` };
  if (evaluation.status === "failed" || evaluation.status === "queued" || evaluation.status === "running") {
    return { ...none, execution: "failed", error: evaluation.error ?? `evaluation is ${evaluation.status}` };
  }
  const issues = inspectOutput(version, evaluation);
  if (issues.length) return { ...none, execution: "invalid_output", issues, error: `${issues.length} problem${issues.length > 1 ? "s" : ""} in the stored output: ${issues[0]!.message}` };
  const rubric = version.rubric;
  const criteria = rubric.criteria.map((c) => observeCriterion(rubric, c, evaluation));
  return { ...none, execution: "completed", criteria, state: caseState(criteria), total: observeTotal(rubric, criteria, evaluation) };
}

/** `needs_info` wins over `abstained` wins over `scored`: one open question keeps the case open. */
function caseState(criteria: CriterionObservation[]): JudgmentState | null {
  const states = criteria.map((c) => c.state);
  if (states.includes("needs_info")) return "needs_info";
  if (states.includes("abstained")) return "abstained";
  return states.includes("scored") ? "scored" : null;
}

function observeCriterion(rubric: Rubric, criterion: Criterion, evaluation: Evaluation): CriterionObservation {
  const result = evaluation.criteria.find((r) => r.criterionId === criterion.id);
  const base: CriterionObservation = {
    criterionId: criterion.id, name: criterion.name, weight: criterion.weight, execution: "ok", state: null, score: null,
    range: scaleRange(criterionScale(rubric, criterion)), normalized: null, requests: [], quotes: [], judges: [],
  };
  if (!result) return { ...base, execution: "missing" };
  const shown = result.ratings.flatMap(withEscalated);
  const told = {
    ...base, judges: [...new Set(shown.map(judgeLabel))],
    quotes: observeQuotes(evaluation.evidence, shown.flatMap((r) => r.quotes ?? [])),
    ...(result.choice !== undefined ? { choice: result.choice } : {}),
    ...(shown.find((r) => r.rationale)?.rationale ? { rationale: shown.find((r) => r.rationale)!.rationale } : {}),
  };
  if (result.status === "excluded") return { ...told, execution: "excluded" };
  if (result.status === "error") return { ...told, execution: "error", error: result.ratings.find((r) => r.error)?.error ?? "the judge returned no rating" };
  return { ...told, ...judged(result) };
}

function judged(result: CriterionResult): Pick<CriterionObservation, "state" | "score" | "normalized" | "requests" | "reason"> {
  if (result.status === "pending") return { state: "abstained", score: null, normalized: null, requests: [], reason: pendingReason(result) };
  const open = result.unresolved;
  if (open) {
    const reason = open.reason ?? (open.state === "needs_info" ? "the document does not state what the rubric needs" : "the rubric's abstain option was chosen");
    return { state: open.state === "needs_info" ? "needs_info" : "abstained", score: null, normalized: null, requests: open.requests ?? [], reason };
  }
  return { state: "scored", score: result.score ?? null, normalized: result.normalized ?? null, requests: [] };
}

function pendingReason(result: CriterionResult): string {
  const escalated = result.ratings.some((r) => r.judgeType === "human" && r.raw?.escalatedFrom);
  return escalated ? "handed to a person: the model's confidence was below the rubric's minConfidence" : "waiting on a human rater";
}

// A rating handed to a person keeps the model's rating inside; its reason and quotes are still worth showing.
function withEscalated(r: Rating): Rating[] {
  const original = r.judgeType === "human" ? r.raw?.escalatedFrom : undefined;
  return original ? [r, original] : [r];
}

function judgeLabel(r: Rating): string {
  const raw = r.judgeType === "decision" || r.judgeType === "llm" ? r.raw : undefined;
  return raw?.provider ? `${r.judgeType} ${raw.provider}${raw.model ? `/${raw.model}` : ""}` : r.judgeType;
}

/** A criterion that feeds the total: weighted, and not a category without values. Optional ones never keep it open. */
function counts(c: Criterion): boolean {
  return c.weight !== 0 && !c.optional && !(c.choices && !c.values);
}

function observeTotal(rubric: Rubric, criteria: CriterionObservation[], evaluation: Evaluation): TotalObservation {
  const open = criteria.filter((o) => o.state !== "scored" && counts(rubric.criteria.find((c) => c.id === o.criterionId)!)).map((o) => o.criterionId);
  const stored = typeof evaluation.aggregate.score === "number" ? evaluation.aggregate.score : null;
  const { passed, grade, range } = evaluation.aggregate;
  return {
    score: open.length ? null : stored, provisional: open.length ? stored : null, range, openCriteria: open, missingPolicy: rubric.aggregation.missing,
    ...(passed !== undefined && !open.length ? { passed } : {}), ...(grade !== undefined && !open.length ? { grade } : {}),
  };
}

/**
 * Checks a stored evaluation against the version it claims to be of. Every finding is a reason not to read the
 * evaluation at all: an unknown criterion, a score outside its scale, an open judgement that also carries a score,
 * a final total beside a question still to be asked.
 */
export function inspectOutput(version: RubricVersion, evaluation: Evaluation): OutputIssue[] {
  const rubric = version.rubric;
  const issues: OutputIssue[] = [];
  for (const result of evaluation.criteria) {
    const criterion = rubric.criteria.find((c) => c.id === result.criterionId);
    if (!criterion) issues.push({ code: "unknown_criterion", criterionId: result.criterionId, message: `criterion ${result.criterionId} is not in the rubric version` });
    else issues.push(...criterionIssues(rubric, criterion, result));
  }
  if (evaluation.status !== "failed" && evaluation.criteria.length) {
    for (const c of rubric.criteria) if (!evaluation.criteria.some((r) => r.criterionId === c.id)) issues.push({ code: "missing_criterion", criterionId: c.id, message: `no result for criterion ${c.id}` });
  }
  return [...issues, ...totalIssues(evaluation)];
}

function criterionIssues(rubric: Rubric, criterion: Criterion, result: CriterionResult): OutputIssue[] {
  const at = (code: string, message: string): OutputIssue => ({ code, criterionId: criterion.id, message: `${criterion.id}: ${message}` });
  const issues: OutputIssue[] = [];
  const [lo, hi] = scaleRange(criterionScale(rubric, criterion));
  const hasScore = typeof result.score === "number";
  if (hasScore && (result.score! < lo - EPS || result.score! > hi + EPS)) issues.push(at("score_out_of_range", `score ${result.score} is outside ${lo}–${hi}`));
  if (typeof result.normalized === "number" && (result.normalized < -EPS || result.normalized > 1 + EPS)) issues.push(at("score_out_of_range", `normalized score ${result.normalized} is outside 0–1`));
  if (result.choice !== undefined && !(criterion.choices && Object.hasOwn(criterion.choices, result.choice))) issues.push(at("unknown_choice", `option ${result.choice} is not one of the criterion's choices`));
  if (result.unresolved) issues.push(...openIssues(criterion, result, result.unresolved).map(([code, message]) => at(code, message)));
  else if (result.status === "scored" && !hasScore && !(criterion.choices && !criterion.values)) issues.push(at("scored_without_score", "marked scored, with no score"));
  return issues;
}

/** An open judgement must be one the rubric declares, and must carry no number. */
function openIssues(criterion: Criterion, result: CriterionResult, open: UnresolvedResult): Array<[string, string]> {
  const issues: Array<[string, string]> = [];
  if (!criterion.unresolved?.[open.option]) issues.push(["unknown_open_option", `${open.option} is not an unresolved option of the rubric version`]);
  const stored = result.score ?? result.normalized;
  if (typeof stored === "number") issues.push(["open_with_score", `the judgement is ${open.state === "needs_info" ? "waiting for information" : "withheld"}, yet a score of ${stored} is stored`]);
  return issues;
}

function totalIssues(evaluation: Evaluation): OutputIssue[] {
  const { aggregate } = evaluation;
  const open = evaluation.criteria.filter((r) => r.unresolved).map((r) => r.criterionId);
  const issues: OutputIssue[] = [];
  if (open.length && typeof aggregate.score === "number" && !aggregate.partial) {
    issues.push({ code: "open_with_final_total", message: `${open.join(", ")} ${open.length > 1 ? "are" : "is"} still open, yet a final total of ${aggregate.score} is stored` });
  }
  if (aggregate.range && typeof aggregate.score === "number" && (aggregate.score < aggregate.range[0] - EPS || aggregate.score > aggregate.range[1] + EPS)) {
    issues.push({ code: "total_out_of_range", message: `total ${aggregate.score} is outside ${aggregate.range[0]}–${aggregate.range[1]}` });
  }
  return issues;
}
