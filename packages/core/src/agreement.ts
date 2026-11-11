/**
 * Checks a rubric against people: runs it over subjects humans already judged and reports how often Verdict reached
 * the same verdict. Subjects the judge handed to a human (low-confidence escalation) are counted separately, never as
 * agreements or disagreements, so escalation cannot inflate the rate.
 */
import { z } from "zod";
import { coerceScore, criterionScale, denormalizeScore, normalizeScore } from "./aggregate/index.js";
import type { Engine, EvaluateRequest } from "./engine.js";
import type { CriterionResult, Evaluation, InputError, Rating } from "./schema/evaluation.js";
import { ValidationError } from "./engine/errors.js";
import type { Criterion, Rubric } from "./schema/rubric.js";
import { Input } from "./schema/subject.js";

/** What a person decided about one subject: the overall verdict and, optionally, per-criterion scores. */
export const HumanLabel = z.object({
  passed: z.boolean().optional(),
  criteria: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});
export type HumanLabel = z.infer<typeof HumanLabel>;

/** Where an expected label came from. An AI-written label is not a human judgement until someone reviews it. */
export const LabelSource = z.enum(["human", "ai_unreviewed", "ai_reviewed", "external", "unknown"]);
export type LabelSource = z.infer<typeof LabelSource>;
/** `development` cases were looked at while editing the rubric; `evaluation` cases were held out. */
export const CaseSplit = z.enum(["development", "evaluation"]);
export type CaseSplit = z.infer<typeof CaseSplit>;

const LabelValue = z.union([z.number(), z.string(), z.boolean()]);

/**
 * One case of a gold set. `expected` is per-criterion labels (the newer name for `human.criteria`); give one or the
 * other. `id` keys a case across gold-set versions and defaults to its name. Extra keys are allowed and ignored.
 */
export const GoldItem = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  inputs: z.array(Input).min(1),
  human: HumanLabel.optional(),
  expected: z.record(z.string(), LabelValue).optional(),
  labelSource: LabelSource.optional(),
  split: CaseSplit.optional(),
  visibility: z.enum(["private", "public"]).optional(),
  kind: z.enum(["normal", "boundary", "counterexample"]).optional(),
  note: z.string().optional(),
}).superRefine((item, ctx) => {
  if (!item.human && !item.expected) ctx.addIssue({ code: "custom", message: "give expected or human labels" });
  if (item.expected && item.human?.criteria) ctx.addIssue({ code: "custom", path: ["expected"], message: "use expected or human.criteria, not both" });
});
export type GoldItem = z.infer<typeof GoldItem>;
/** A gold item after parsing: `human` merges `expected`, and every case has an `id`. */
export type LabelledCase = GoldItem & { id: string; human: HumanLabel };

/**
 * Verdict vs. the human on one criterion. Choice criteria compare option ids, so `verdict` and `human` are strings
 * there. `verdict` and `agrees` are null while the criterion waits on a human or failed.
 */
export interface CriterionAgreement { verdict: number | string | null; human: number | string; confidence: number | null; agrees: boolean | null; askedHuman: boolean }

/** Verdict vs. the human on one subject. `passed` is null when the evaluation waits on a human or failed. */
export interface AgreementItem {
  id: string; name: string; evaluationId: string; human: HumanLabel;
  labelSource?: LabelSource; split?: CaseSplit;
  passed: boolean | null; score: number | null; agrees: boolean | null; askedHuman: boolean;
  criteria: Record<string, CriterionAgreement>;
  /** Present when the case failed the rubric's inputSchema; no judge ran for it. */
  inputErrors?: InputError[];
  preview?: string;
}

/** Overall agreement within one split. */
export interface SplitTally { items: number; decided: number; agreed: number; agreement: number | null }

/** Totals per criterion: `n` counts only criteria Verdict decided itself. */
export interface CriterionTally { n: number; agreed: number; agreement: number | null; askedHuman: number }

/** The whole check. `agreement` = agreed / decided, over subjects with both a Verdict and a human verdict. */
export interface AgreementReport {
  rubric: string; items: number;
  decided: number; agreed: number; agreement: number | null; askedHuman: number;
  /** Failed evaluations, including `invalidInput`. */
  failed: number;
  /** Cases rejected by the rubric's inputSchema before any judge ran. */
  invalidInput: number;
  criteria: Record<string, CriterionTally>;
  /** Agreement per split; cases without a split are counted under `unspecified`. */
  splits: Record<string, SplitTally>;
  /** How many cases carry each label source; cases without one are counted under `unspecified`. */
  labelSources: Record<string, number>;
  results: AgreementItem[];
}

/** Parses a gold set (JSON array or JSON lines). Relative file paths resolve against `baseDir`. */
export function parseGoldSet(text: string, baseDir?: string): LabelledCase[] {
  const trimmed = text.trim();
  const raw: unknown[] = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const items = raw.map((entry, i) => {
    const parsed = GoldItem.safeParse(entry);
    if (!parsed.success) throw new Error(`gold item ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
    return baseDir ? { ...parsed.data, inputs: parsed.data.inputs.map((inp) => resolvePath(inp, baseDir)) } : parsed.data;
  });
  return labelCases(items);
}

/**
 * Merges `expected` into `human` and assigns ids: explicit ids must be unique; a missing id is the case name, with
 * `#2`, `#3`, … appended when names repeat. Idempotent, so already-labelled cases pass through unchanged.
 */
export function labelCases(items: GoldItem[]): LabelledCase[] {
  const explicit = new Set<string>();
  for (const item of items) {
    if (item.id === undefined) continue;
    if (explicit.has(item.id)) throw new ValidationError(`duplicate gold case id "${item.id}"`);
    explicit.add(item.id);
  }
  const used = new Set(explicit);
  return items.map((item) => {
    const id = item.id ?? uniqueId(item.name, used);
    used.add(id);
    const human: HumanLabel = { ...item.human, ...(item.expected ? { criteria: item.expected } : {}) };
    return { ...item, id, human };
  });
}

/**
 * A labelled case back in the shape gold files and requests use: labels under `expected` only, an overall verdict
 * (if any) under `human.passed`. `labelCases` merges `expected` into `human`; sending both would be refused.
 */
export function toGoldItem(c: LabelledCase): GoldItem {
  const { human, expected: _expected, ...rest } = c;
  return { ...rest, expected: human.criteria ?? {}, ...(human.passed !== undefined ? { human: { passed: human.passed } } : {}) };
}

function uniqueId(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name}#${n}`)) n++;
  return `${name}#${n}`;
}

/**
 * Rejects labels the rubric cannot read before any judge runs, so a typo never costs a full batch of calls.
 * Labels for criteria the rubric does not have are allowed: gold sets outlive rubric edits.
 */
export function validateGoldLabels(rubric: Rubric, items: GoldItem[]): void {
  for (const item of labelCases(items)) {
    for (const [id, value] of Object.entries(item.human.criteria ?? {})) {
      const criterion = rubric.criteria.find((c) => c.id === id);
      if (!criterion) continue;
      try { readLabel(rubric, criterion, value); }
      catch (e) { throw new ValidationError(`gold case "${item.id}", criterion ${id}: ${(e as Error).message}`); }
    }
  }
}

/** A label on the criterion's own terms: the option id for choices, a snapped score otherwise. Throws when unreadable. */
export function readLabel(rubric: Rubric, criterion: Criterion, value: number | string | boolean): number | string {
  if (criterion.choices) {
    if (typeof value !== "string" || !Object.hasOwn(criterion.choices, value)) throw new ValidationError(`expected one of ${Object.keys(criterion.choices).join(", ")}`);
    return value;
  }
  return coerceScore(typeof value === "boolean" ? Number(value) : value, criterionScale(rubric, criterion));
}

// String joins keep this module free of node:path, so it stays importable on Workers.
function resolvePath(inp: Input, baseDir: string): Input {
  if (inp.type !== "file" || !inp.path || /^([a-zA-Z]:)?[\\/]/.test(inp.path)) return inp;
  return { ...inp, path: `${baseDir.replace(/[\\/]+$/, "")}/${inp.path}` };
}

/** Compares finished evaluations with their human labels. Pure: never calls a judge. */
export function agreementReport(rubric: Rubric, pairs: Array<{ item: GoldItem; evaluation: Evaluation; preview?: string }>): AgreementReport {
  const cases = labelCases(pairs.map((p) => p.item));
  const results = pairs.map(({ evaluation, preview }, i) => compareItem(rubric, cases[i]!, evaluation, preview));
  const decided = results.filter((r) => r.agrees !== null).length;
  const agreed = results.filter((r) => r.agrees === true).length;
  return {
    rubric: rubric.name, items: results.length,
    decided, agreed, agreement: decided ? agreed / decided : null,
    askedHuman: results.filter((r) => r.askedHuman).length,
    failed: pairs.filter((p) => p.evaluation.status === "failed").length,
    invalidInput: results.filter((r) => r.inputErrors).length,
    criteria: tallyCriteria(results), splits: tallySplits(results), labelSources: countBy(results, (r) => r.labelSource), results,
  };
}

function compareItem(rubric: Rubric, item: LabelledCase, ev: Evaluation, preview?: string): AgreementItem {
  // Only a completed evaluation has a verdict; pending and failed ones are not counted either way.
  const passed = ev.status === "completed" ? ev.aggregate.passed ?? null : null;
  const criteria: Record<string, CriterionAgreement> = {};
  for (const [id, value] of Object.entries(item.human.criteria ?? {})) {
    const c = compareCriterion(rubric, id, value, ev.criteria.find((r) => r.criterionId === id));
    if (c) criteria[id] = c;
  }
  const agrees = passed === null || item.human.passed === undefined ? null : passed === item.human.passed;
  return {
    id: item.id, name: item.name, evaluationId: ev.id, human: item.human,
    ...(item.labelSource ? { labelSource: item.labelSource } : {}), ...(item.split ? { split: item.split } : {}),
    passed, score: ev.aggregate?.score ?? null, agrees, askedHuman: ev.status === "pending_human", criteria,
    ...(ev.inputErrors?.length ? { inputErrors: ev.inputErrors } : {}), ...(preview ? { preview } : {}),
  };
}

function compareCriterion(rubric: Rubric, id: string, value: number | string | boolean, result: CriterionResult | undefined): CriterionAgreement | undefined {
  const criterion = rubric.criteria.find((c) => c.id === id);
  // Labels for criteria the rubric doesn't have are ignored: gold sets outlive rubric edits.
  if (!criterion) return undefined;
  const human = readLabel(rubric, criterion, value);
  const confidence = modelConfidence(result?.ratings ?? []), askedHuman = result?.status === "pending";
  if (typeof human === "string") {
    // Choices compare option ids: two options that share a value are still different answers.
    const verdict = result?.status === "scored" ? result.choice ?? null : null;
    return { verdict, human, confidence, agrees: verdict === null ? null : verdict === human, askedHuman };
  }
  const scale = criterionScale(rubric, criterion);
  const scored = result?.status === "scored" && typeof result.normalized === "number";
  // Compare on the criterion's own scale, as calibrate() does, so "close" never counts as a match.
  const verdict = scored ? denormalizeScore(result.normalized!, scale) : null;
  const agrees = verdict === null ? null : verdict === denormalizeScore(normalizeScore(human, scale), scale);
  return { verdict, human, confidence, agrees, askedHuman };
}

// An escalated criterion keeps the model's rating inside the pending human rating; report that confidence too.
function modelConfidence(ratings: Rating[]): number | null {
  for (const r of ratings) {
    if (r.judgeType !== "human" && typeof r.confidence === "number") return r.confidence;
    const escalated = r.judgeType === "human" && r.raw && "escalatedFrom" in r.raw ? r.raw.escalatedFrom : undefined;
    if (escalated && typeof escalated === "object" && "confidence" in escalated && typeof escalated.confidence === "number") return escalated.confidence;
  }
  return null;
}

function tallyCriteria(results: AgreementItem[]): Record<string, CriterionTally> {
  const out: Record<string, CriterionTally> = {};
  for (const [id, c] of results.flatMap((r) => Object.entries(r.criteria))) {
    const t = (out[id] ??= { n: 0, agreed: 0, agreement: null, askedHuman: 0 });
    if (c.askedHuman) t.askedHuman++;
    else if (c.agrees !== null) { t.n++; if (c.agrees) t.agreed++; }
  }
  for (const t of Object.values(out)) t.agreement = t.n ? t.agreed / t.n : null;
  return out;
}

function tallySplits(results: AgreementItem[]): Record<string, SplitTally> {
  const out: Record<string, SplitTally> = {};
  for (const r of results) {
    const t = (out[r.split ?? "unspecified"] ??= { items: 0, decided: 0, agreed: 0, agreement: null });
    t.items++;
    if (r.agrees !== null) { t.decided++; if (r.agrees) t.agreed++; }
  }
  for (const t of Object.values(out)) t.agreement = t.decided ? t.agreed / t.decided : null;
  return out;
}

function countBy<T>(xs: T[], key: (x: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) { const k = key(x) ?? "unspecified"; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

function preview(inputs: Input[], max: number): string | undefined {
  const t = inputs.find((i) => i.type === "text");
  if (!t || t.type !== "text") return undefined;
  return t.text.length > max ? `${t.text.slice(0, max)}…` : t.text;
}

/** One subject per case. The label rides along as metadata, so stored evaluations can be checked again without the gold file. */
export function caseSubjects(cases: LabelledCase[]) {
  return cases.map((c) => ({ name: c.name, inputs: c.inputs, metadata: { caseId: c.id, human: c.human, ...(c.labelSource ? { labelSource: c.labelSource } : {}), ...(c.split ? { split: c.split } : {}) } }));
}

/** Runs `rubric` over every gold item as one batch and reports agreement with the human labels. Judge errors surface as failed items, never as a throw. */
export async function checkAgainstHumans(engine: Engine, rubric: EvaluateRequest["rubric"], items: GoldItem[], opts: { previewChars?: number; tenantId?: string } = {}): Promise<AgreementReport> {
  if (!items.length) throw new Error("the gold set is empty");
  const { rubric: resolved } = await engine.resolveRubric(rubric, opts.tenantId);
  validateGoldLabels(resolved, items);
  const cases = labelCases(items);
  const { evaluations } = await engine.evaluateBatch(resolved, caseSubjects(cases), { tenantId: opts.tenantId });
  const max = opts.previewChars ?? 240;
  const pairs = cases.map((item, i) => ({ item, evaluation: evaluations[i]!, preview: max > 0 ? preview(item.inputs, max) : undefined }));
  return agreementReport(resolved, pairs);
}
