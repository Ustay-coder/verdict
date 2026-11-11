/**
 * Compares two runs case by case (docs/design/hub.md §7). Pure: reads stored evaluations, never calls a judge.
 * It answers "what did this rubric change do?" only when everything else matched; otherwise the result is labelled a
 * comparison under different conditions and the per-case rows are still shown side by side. Errors, escalations and
 * missing cases are never counted as agreement or disagreement, and every rate comes with its denominator.
 */
import { readLabel } from "../agreement.js";
import { canonicalJson } from "../idempotency.js";
import { criterionScale, denormalizeScore } from "../aggregate/index.js";
import type { CriterionResult, Evaluation, Rating } from "../schema/evaluation.js";
import type { Criterion, Rubric } from "../schema/rubric.js";
import type { DatasetVersion } from "./dataset.js";
import type { RubricVersion } from "./rubric-version.js";
import type { Run, RunFingerprint } from "./run.js";
import { outputContract, type OutputContract } from "./split.js";

export interface RunSide { run: Run; version: RubricVersion; evaluations: Evaluation[] }

/**
 * `rubric_change`: only the rubric's judgment differs. `policy_change`: only how answers are read differs (thresholds,
 * values, weights, aggregation) — the same answers, read another way. `same_conditions`: nothing differs (a repeat run).
 */
/** Listed once: the report a server accepts is checked against this list, so a new kind cannot be one a server refuses. */
export const COMPARISON_KINDS = ["rubric_change", "policy_change", "same_conditions", "different_conditions"] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];

export interface ConditionDiff { field: string; base: unknown; head: unknown }

export type CaseClass = "kept_match" | "kept_miss" | "fixed" | "regressed" | "same_unlabelled" | "changed_unlabelled" | "escalated" | "error" | "missing" | "incomparable";

export interface CaseSide {
  status: "scored" | "escalated" | "error" | "invalid_input" | "missing";
  verdict: number | string | null;
  agrees: boolean | null;
  /** Distance of the decision from flipping, from the model's probabilities: |p − threshold| for noul, top-two gap otherwise. */
  gap: number | null;
  probabilities?: Record<string, number>;
}

export interface CaseComparison { caseId: string; name?: string; class: CaseClass; expected?: number | string | boolean; base: CaseSide; head: CaseSide; nearBoundary: boolean }

export interface CriterionComparison {
  criterionId: string;
  contract: { same: boolean; base: OutputContract; head: OutputContract };
  counts: Record<CaseClass, number> & { cases: number; commonSucceeded: number; labelled: number; nearBoundary: number };
  /** Agreement with the labels over cases both runs scored and that carry a label; null without such cases. */
  agreement: { n: number; base: number | null; head: number | null };
  cases: CaseComparison[];
}

export interface Comparison {
  kind: ComparisonKind;
  base: { runId: string; rubricVersionId: string };
  head: { runId: string; rubricVersionId: string };
  conditions: { same: boolean; diffs: ConditionDiff[] };
  labels: { datasetVersionId: string; labelsHash: string; rescored: { base: boolean; head: boolean } };
  criteria: CriterionComparison[];
}

export interface CompareOptions {
  /** Minimum move toward the boundary, and maximum remaining distance, for a case to be flagged near the boundary. */
  nearMargin?: number;
}

const DEFAULT_NEAR_MARGIN = 0.1;
// Compared in this order; judgment and question differences are what a rubric change is expected to show.
const CONDITION_FIELDS = ["casesHash", "bindingHash", "policyHash", "adapterVersion", "scoring", "models", "judgmentHash", "questionsHash"] as const;
const RUBRIC_FIELDS = new Set<string>(["judgmentHash", "questionsHash"]);

/** Compares `head` against `base`, scoring both against `labels` (re-scoring a run whose own labels differ). */
export function compareRuns(base: RunSide, head: RunSide, labels: DatasetVersion, opts: CompareOptions = {}): Comparison {
  const diffs = conditionDiffs(base.run.fingerprint, head.run.fingerprint, labels);
  const rubricOnly = diffs.length > 0 && diffs.every((d) => RUBRIC_FIELDS.has(d.field)) && diffs.some((d) => d.field === "judgmentHash");
  const margin = opts.nearMargin ?? DEFAULT_NEAR_MARGIN;
  const shared = head.version.rubric.criteria.filter((c) => base.version.rubric.criteria.some((b) => b.id === c.id));
  return {
    kind: comparisonKind(diffs, rubricOnly),
    base: { runId: base.run.id, rubricVersionId: base.version.id },
    head: { runId: head.run.id, rubricVersionId: head.version.id },
    conditions: { same: diffs.length === 0, diffs },
    labels: { datasetVersionId: labels.id, labelsHash: labels.labelsHash, rescored: { base: base.run.fingerprint.labelsHash !== labels.labelsHash, head: head.run.fingerprint.labelsHash !== labels.labelsHash } },
    criteria: shared.map((c) => compareCriterion(base, head, c.id, labels, margin)),
  };
}

function comparisonKind(diffs: ConditionDiff[], rubricOnly: boolean): ComparisonKind {
  if (diffs.length === 0) return "same_conditions";
  if (rubricOnly) return "rubric_change";
  return diffs.every((d) => d.field === "policyHash") ? "policy_change" : "different_conditions";
}

function conditionDiffs(a: RunFingerprint, b: RunFingerprint, labels: DatasetVersion): ConditionDiff[] {
  const diffs: ConditionDiff[] = [];
  for (const field of CONDITION_FIELDS) {
    if (canonicalJson(a[field]) !== canonicalJson(b[field])) diffs.push({ field, base: a[field], head: b[field] });
  }
  // A model named only by its requested alias may have changed underneath; never call that the same model.
  const unverified = [...a.models, ...b.models].filter((m) => !m.verified);
  if (unverified.length) diffs.push({ field: "modelsUnverified", base: a.models.filter((m) => !m.verified), head: b.models.filter((m) => !m.verified) });
  if (labels.casesHash !== a.casesHash || labels.casesHash !== b.casesHash) diffs.push({ field: "labelsWrittenForOtherInputs", base: a.casesHash, head: b.casesHash });
  return diffs;
}

function compareCriterion(base: RunSide, head: RunSide, criterionId: string, labels: DatasetVersion, margin: number): CriterionComparison {
  const cb = base.version.rubric.criteria.find((c) => c.id === criterionId)!, ch = head.version.rubric.criteria.find((c) => c.id === criterionId)!;
  const contract = { base: outputContract(base.version.rubric, cb), head: outputContract(head.version.rubric, ch) };
  const comparable = canonicalJson(contract.base) === canonicalJson(contract.head);
  const caseIds = unique([...base.run.cases, ...head.run.cases].map((c) => c.caseId));
  const cases = caseIds.map((caseId) => {
    const item = labels.cases.find((c) => c.id === caseId);
    const expected = item?.human.criteria?.[criterionId];
    const b = side(base, caseId, cb, expected), h = side(head, caseId, ch, expected);
    const cls = comparable ? classify(b, h, expected !== undefined) : "incomparable";
    return { caseId, ...(item ? { name: item.name } : {}), class: cls, ...(expected !== undefined ? { expected } : {}), base: b, head: h, nearBoundary: nearBoundary(cls, b, h, margin) };
  });
  return { criterionId, contract: { same: comparable, ...contract }, counts: tally(cases), agreement: agreement(cases), cases };
}

function side(s: RunSide, caseId: string, criterion: Criterion, expected: number | string | boolean | undefined): CaseSide {
  const evaluationId = s.run.cases.find((c) => c.caseId === caseId)?.evaluationId;
  const ev = s.evaluations.find((e) => e.id === evaluationId);
  if (!ev) return { status: "missing", verdict: null, agrees: null, gap: null };
  if (ev.inputErrors?.length) return { status: "invalid_input", verdict: null, agrees: null, gap: null };
  const result = ev.criteria.find((c) => c.criterionId === criterion.id);
  const rating = decisionRating(result);
  const shape = { gap: rating ? decisionGap(rating) : null, ...(rating?.probabilities ? { probabilities: rating.probabilities } : {}) };
  if (result?.status === "pending") return { status: "escalated", verdict: null, agrees: null, ...shape };
  const verdict = result ? verdictOf(s.version.rubric, criterion, result) : null;
  if (verdict === null) return { status: "error", verdict: null, agrees: null, ...shape };
  return { status: "scored", verdict, agrees: expected === undefined ? null : sameLabel(s.version.rubric, criterion, verdict, expected), ...shape };
}

function verdictOf(rubric: Rubric, criterion: Criterion, result: CriterionResult): number | string | null {
  if (result.status !== "scored") return null;
  if (criterion.choices) return result.choice ?? null;
  return typeof result.normalized === "number" ? denormalizeScore(result.normalized, criterionScale(rubric, criterion)) : null;
}

function sameLabel(rubric: Rubric, criterion: Criterion, verdict: number | string, expected: number | string | boolean): boolean | null {
  try { return readLabel(rubric, criterion, expected) === verdict; }
  catch { return null; }
}

// The model's own rating — kept inside an escalated human slot when the answer was handed to a person.
function decisionRating(result: CriterionResult | undefined): Rating | undefined {
  for (const r of result?.ratings ?? []) {
    if (r.judgeType === "decision" && r.status === "scored") return r;
    const original = r.judgeType === "human" && r.raw && "escalatedFrom" in r.raw ? r.raw.escalatedFrom : undefined;
    if (original?.judgeType === "decision") return original;
  }
  return undefined;
}

function decisionGap(r: Rating): number | null {
  const probabilities = Object.values(r.probabilities ?? {});
  if (!probabilities.length) return null;
  const raw = r.judgeType === "decision" ? r.raw : undefined;
  if (raw?.threshold !== undefined && probabilities.length === 2) {
    // The true label is the second level (worst → best); read it by name rather than by key order.
    const yes = raw.levels?.[1]?.label;
    const p = yes !== undefined && r.probabilities![yes] !== undefined ? r.probabilities![yes]! : probabilities[1]!;
    return round(Math.abs(p - raw.threshold));
  }
  const [first = 0, second = 0] = [...probabilities].sort((x, y) => y - x);
  return round(first - second);
}

function classify(b: CaseSide, h: CaseSide, labelled: boolean): CaseClass {
  if (b.status === "missing" || h.status === "missing") return "missing";
  if (b.status === "error" || h.status === "error" || b.status === "invalid_input" || h.status === "invalid_input") return "error";
  if (b.status === "escalated" || h.status === "escalated") return "escalated";
  if (!labelled || b.agrees === null || h.agrees === null) return b.verdict === h.verdict ? "same_unlabelled" : "changed_unlabelled";
  if (b.agrees && h.agrees) return "kept_match";
  if (!b.agrees && !h.agrees) return "kept_miss";
  return h.agrees ? "fixed" : "regressed";
}

// Same verdict, but the head moved at least `margin` toward flipping and is now within `margin` of it.
function nearBoundary(cls: CaseClass, b: CaseSide, h: CaseSide, margin: number): boolean {
  if (!["kept_match", "kept_miss", "same_unlabelled"].includes(cls) || b.gap === null || h.gap === null) return false;
  return h.gap < margin && b.gap - h.gap >= margin;
}

function tally(cases: CaseComparison[]): CriterionComparison["counts"] {
  const classes: CaseClass[] = ["kept_match", "kept_miss", "fixed", "regressed", "same_unlabelled", "changed_unlabelled", "escalated", "error", "missing", "incomparable"];
  const counts = Object.fromEntries(classes.map((k) => [k, cases.filter((c) => c.class === k).length])) as Record<CaseClass, number>;
  return {
    ...counts, cases: cases.length,
    commonSucceeded: cases.filter((c) => c.base.status === "scored" && c.head.status === "scored").length,
    labelled: cases.filter((c) => c.expected !== undefined).length,
    nearBoundary: cases.filter((c) => c.nearBoundary).length,
  };
}

function agreement(cases: CaseComparison[]): CriterionComparison["agreement"] {
  const both = cases.filter((c) => c.base.agrees !== null && c.head.agrees !== null && c.class !== "incomparable");
  const rate = (pick: (c: CaseComparison) => boolean | null) => (both.length ? both.filter((c) => pick(c) === true).length / both.length : null);
  return { n: both.length, base: rate((c) => c.base.agrees), head: rate((c) => c.head.agrees) };
}

const unique = <T>(xs: T[]) => [...new Set(xs)];
const round = (x: number) => Math.round(x * 10_000) / 10_000;
