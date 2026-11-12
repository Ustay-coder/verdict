/**
 * One rubric judged by several decision models over the same cases, read side by side: how often each agreed with
 * the labels, what it cost, and every case where the models did not give the same answer. Pure: it reads finished
 * runs and calls no judge.
 *
 * The runs differ only in which model answered (the versions share a judgment hash and differ in binding), so a
 * difference here is the model's. Whether the same questions really went out is read from the runs, not assumed.
 */
import { criterionScale } from "../aggregate/index.js";
import { criterionAnswer, type AgreementReport } from "../agreement.js";
import { criterionLevels } from "../judges/decision/questions.js";
import type { CriterionResult, Evaluation, Rating } from "../schema/evaluation.js";
import type { Criterion, Rubric } from "../schema/rubric.js";
import type { DatasetVersion } from "./dataset.js";
import type { RubricVersion } from "./rubric-version.js";
import type { Run, RunModel } from "./run.js";

/** One model's finished run. `label` is what the person called the model. */
export interface ModelSide { label: string; run: Run; version: RubricVersion; evaluations: Evaluation[]; report: AgreementReport }

export interface ModelRow {
  label: string; runId: string; versionId: string; status: Run["status"];
  /** The models that answered, as the run recorded them: the name asked for and the one the provider said it used. */
  models: RunModel[];
  counts: Run["counts"];
  /** Labelled criteria this model decided itself, over every case, and how many matched the label. */
  labelled: { n: number; agreed: number; agreement: number | null };
  usage: Run["usage"];
  durationMs: number;
  /** Why nothing came back, when a case failed: the first reason given. */
  error?: string;
}

/**
 * `shown` is the answer in the rubric's own words: a level's label where the scale names its levels. `probability`
 * is what the model put on that answer, the one number that means the same for every model; it is null where the
 * answer is not an option the model weighed (a score between two levels) or no model answered. `confidence` is the
 * provider's own summary, and providers do not compute it alike, so it is not for comparing one model with another.
 */
export interface ModelAnswer { label: string; answer: number | string | null; shown: string; probability: number | null; confidence: number | null }

/** A case and criterion the models did not all answer alike. `expected` is the label, where the case has one. */
export interface ModelSplit { caseId: string; name: string; criterionId: string; expected?: { answer: number | string; shown: string }; answers: ModelAnswer[] }

export interface ModelComparison {
  rubric: string; dataset: string; cases: number;
  /** True when every run that got answers recorded the same questions: the models were asked the same thing. */
  sameQuestions: boolean;
  models: ModelRow[];
  /**
   * Case × criterion pairs every model answered, and how many of them got one answer from all. A model whose whole
   * run failed is left out of these and of `splits`: it has a row that says why, and it disagrees with nobody.
   */
  answered: number; unanimous: number;
  splits: ModelSplit[];
}

function row(side: ModelSide): ModelRow {
  const tallies = Object.values(side.report.criteria);
  const n = tallies.reduce((sum, t) => sum + t.n, 0), agreed = tallies.reduce((sum, t) => sum + t.agreed, 0);
  // What the provider said comes before the engine's summary of it ("every criterion failed to score").
  const failure = side.evaluations.map((e) => e.criteria.flatMap((c) => c.ratings).find((r) => r.status === "error")?.error ?? e.error).find(Boolean);
  return {
    label: side.label, runId: side.run.id, versionId: side.version.id, status: side.run.status, models: side.run.fingerprint.models, counts: side.run.counts,
    labelled: { n, agreed, agreement: n ? agreed / n : null }, usage: side.run.usage,
    durationMs: Date.parse(side.run.finishedAt) - Date.parse(side.run.startedAt),
    ...(failure ? { error: failure } : {}),
  };
}

/** An answer as a person reads it: `yes` rather than 1 where the scale names its levels; `—` when there is none. */
export function answerLabel(rubric: Rubric, criterion: Criterion, answer: number | string | null): string {
  if (answer === null) return "—";
  if (typeof answer === "string") return answer;
  const scale = criterionScale(rubric, criterion);
  if (scale.type === "binary") return scale.labels?.[answer] ?? String(answer);
  if (scale.type === "ordinal") return scale.labels[scale.values ? scale.values.indexOf(answer) : answer] ?? String(answer);
  return String(answer);
}

// An escalated criterion keeps the model's rating inside the pending human rating.
function modelRating(ratings: Rating[]): Rating | undefined {
  for (const r of ratings) {
    if (r.judgeType !== "human") return r;
    const original = r.raw && "escalatedFrom" in r.raw ? r.raw.escalatedFrom : undefined;
    if (original) return original;
  }
  return undefined;
}

/** The probability the model gave the answer: an option id for a choice, the label of the level the answer is otherwise. */
function answerProbability(rubric: Rubric, criterion: Criterion, result: CriterionResult | undefined, answer: number | string | null): number | null {
  const probabilities = modelRating(result?.ratings ?? [])?.probabilities;
  if (!probabilities || answer === null) return null;
  const option = typeof answer === "string" ? answer : criterionLevels(rubric, criterion, criterionScale(rubric, criterion)).find((level) => level.value === answer)?.label;
  return option !== undefined && Object.hasOwn(probabilities, option) ? probabilities[option]! : null;
}

/** Each side's answer to one criterion of one case. */
function answers(sides: ModelSide[], byId: Array<Map<string, Evaluation>>, index: number, criterion: Criterion): ModelAnswer[] {
  return sides.map((side, s) => {
    const evaluation = byId[s]!.get(side.run.cases[index]?.evaluationId ?? "");
    const result = evaluation?.criteria.find((r) => r.criterionId === criterion.id);
    const given = criterionAnswer(side.version.rubric, criterion, result);
    return { label: side.label, answer: given.answer, shown: answerLabel(side.version.rubric, criterion, given.answer), probability: answerProbability(side.version.rubric, criterion, result, given.answer), confidence: given.confidence };
  });
}

/** Sides must be runs of the same cases, in the same order: `runCases` over one dataset gives that. */
export function compareModels(sides: ModelSide[], dataset: DatasetVersion): ModelComparison {
  const first = sides[0];
  if (!first) throw new Error("compareModels needs at least one run");
  const live = sides.filter((side) => side.run.status !== "failed");
  const byId = live.map((side) => new Map(side.evaluations.map((e) => [e.id, e])));
  const splits: ModelSplit[] = [];
  let answered = 0, unanimous = 0;
  dataset.cases.forEach((item, index) => {
    for (const criterion of first.version.rubric.criteria) {
      const given = answers(live, byId, index, criterion);
      if (!given.length) continue;
      const distinct = new Set(given.map((a) => a.answer));
      if (!distinct.has(null)) answered++;
      if (distinct.size === 1) { if (!distinct.has(null)) unanimous++; continue; }
      const expected = first.report.results[index]?.criteria[criterion.id]?.human;
      const label = expected === undefined ? undefined : { answer: expected, shown: answerLabel(first.version.rubric, criterion, expected) };
      splits.push({ caseId: item.id, name: item.name, criterionId: criterion.id, ...(label ? { expected: label } : {}), answers: given });
    }
  });
  // A run that sent nothing (it failed before asking, or no decision model was reached) has no questions to differ.
  const sent = new Set(sides.map((side) => side.run.fingerprint.questionsHash).filter((hash) => hash !== null));
  return {
    rubric: first.version.rubric.name, dataset: dataset.name ?? dataset.id, cases: dataset.cases.length,
    sameQuestions: sent.size <= 1, models: sides.map(row), answered, unanimous, splits,
  };
}
