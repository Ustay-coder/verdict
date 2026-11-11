/**
 * Re-scoring a run under another version's policy without asking any judge (docs/design/hub.md X3). When two
 * versions differ only in how answers are read — thresholds, choice values, weights, aggregation, low-confidence
 * handling — the answers a model already gave are replayed through the engine under the new version, so every rule is
 * applied by the same code as a real run. A question that would read differently was never asked: it is refused.
 */
import { caseSubjects } from "../agreement.js";
import { ValidationError } from "../engine/errors.js";
import type { Engine } from "../engine.js";
import type { ReplayOptions } from "../judges/decision/providers.js";
import { parseRubric, type Rubric } from "../schema/rubric.js";
import type { Evaluation, Rating } from "../schema/evaluation.js";
import type { DatasetVersion } from "./dataset.js";
import type { RubricVersion } from "./rubric-version.js";
import { assembleRun, scoreRun, type Run, type RunResult } from "./run.js";

export interface RunSource { run: Run; version: RubricVersion; evaluations: Evaluation[] }

/** Why `head` cannot be re-scored from `base`'s answers, or undefined when it can be (as far as the versions tell). */
export function policyRescoreBlocker(base: RubricVersion, head: RubricVersion): string | undefined {
  if (base.judgmentHash !== head.judgmentHash) return "the questions differ, so the judges have to be asked again";
  if (base.bindingHash !== head.bindingHash) return "the judges' providers or models differ";
  if (base.policyHash === head.policyHash) return "the policy is the same";
  if (head.rubric.checks?.length) return "checks are not replayed";
  const other = judgeTypes(head.rubric).find((t) => t !== "decision");
  if (other) return `only decision judges can be replayed, and this rubric uses a ${other} judge`;
  return undefined;
}

/**
 * A run of `head` over `dataset` made from `base`'s recorded answers. Throws a ValidationError saying why when that is
 * not possible: then the cases have to be run.
 */
export async function rescoreRunUnder(engine: Engine, base: RunSource, head: RubricVersion, dataset: DatasetVersion, opts: { tenantId?: string; now?: () => number } = {}): Promise<RunResult> {
  const blocker = policyRescoreBlocker(base.version, head);
  if (blocker) throw new ValidationError(`cannot re-score ${base.run.id} as ${head.id}: ${blocker}`);
  if (dataset.casesHash !== base.run.fingerprint.casesHash) throw new ValidationError(`cannot re-score ${base.run.id}: the cases' inputs changed`);
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const byCase = new Map(base.run.cases.map((c) => [c.caseId, base.evaluations.find((e) => e.id === c.evaluationId)]));
  const subjects = caseSubjects(dataset.cases);
  // Every case's answers are checked before any is replayed, so a refusal leaves nothing half-stored.
  const recordings = dataset.cases.map((item) => recordedDecisions(byCase.get(item.id), item.id));
  const evaluations: Evaluation[] = [];
  for (const [i, item] of dataset.cases.entries()) {
    const recorded = recordings[i]!;
    const evaluation = await engine.evaluate({ rubric: replayRubric(head.rubric, recorded), subject: subjects[i]!, tenantId: opts.tenantId });
    const failed = evaluation.criteria.flatMap((c) => c.ratings).find((r) => r.status === "error");
    if (failed) throw new ValidationError(`cannot re-score case ${item.id}: ${failed.error}`);
    const restored = restoreEvaluation(evaluation, head.rubric, recorded);
    await engine.store.putEvaluation(restored);
    evaluations.push(restored);
  }
  const run = await assembleRun(head, dataset, evaluations, { tenantId: opts.tenantId, startedAt, finishedAt: new Date(now()).toISOString(), rescoredFrom: base.run.id });
  return { run, evaluations, report: scoreRun(head, dataset, evaluations) };
}

/** The decision rating each criterion got, including one a person was asked to replace. */
type DecisionRating = Rating<"decision">;

function recordedDecisions(evaluation: Evaluation | undefined, caseId: string): Map<string, DecisionRating> {
  if (!evaluation) throw new ValidationError(`cannot re-score: case ${caseId} has no recorded evaluation`);
  const out = new Map<string, DecisionRating>();
  for (const criterion of evaluation.criteria) {
    const decisions = criterion.ratings.flatMap(decisionRatings);
    if (decisions.length > 1) throw new ValidationError(`cannot re-score: ${criterion.criterionId} has ${decisions.length} decision ratings in case ${caseId} (panels are asked again)`);
    const rating = decisions[0];
    if (!rating?.raw?.answer || !rating.raw.question) throw new ValidationError(`cannot re-score: case ${caseId} has no recorded answer for ${criterion.criterionId}`);
    out.set(criterion.criterionId, rating);
  }
  return out;
}

function decisionRatings(r: Rating): DecisionRating[] {
  if (r.judgeType === "decision") return [r];
  const original = escalatedFrom(r);
  return original?.judgeType === "decision" ? [original] : [];
}

function escalatedFrom(r: Rating): Rating | undefined {
  return r.raw && typeof r.raw === "object" && "escalatedFrom" in r.raw ? (r.raw.escalatedFrom as Rating | undefined) : undefined;
}

/** `rubric` with every decision judge answering from the recording; judge ids are kept so ratings keep their raters. */
function replayRubric(rubric: Rubric, recorded: Map<string, DecisionRating>): Rubric {
  const replay: ReplayOptions = { answers: {}, questions: {} };
  for (const [id, r] of recorded) { replay.answers[id] = r.raw!.answer!; replay.questions[id] = r.raw!.question!; }
  const walk = (spec: unknown): unknown => {
    const s = spec as { type?: string; id?: string; provider?: string; model?: string; options?: Record<string, unknown> };
    if (s?.type !== "decision") return spec;
    const { baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, ...rest } = s as typeof s & { baseUrl?: string; apiKeyEnv?: string };
    return { ...rest, id: s.id ?? `decision:${s.provider ?? "typesafe"}${s.model ? `/${s.model}` : ""}`, provider: "mock", options: { ...s.options, replay } };
  };
  return parseRubric({
    ...rubric,
    judges: Object.fromEntries(Object.entries(rubric.judges).map(([k, v]) => [k, walk(v)])),
    defaultJudge: walk(rubric.defaultJudge),
    criteria: rubric.criteria.map((c) => ({ ...c, ...(c.judge ? { judge: Array.isArray(c.judge) ? c.judge.map(walk) : walk(c.judge) } : {}) })),
  });
}

/** The replayed evaluation as a run of `rubric` would have stored it: the real provider and model, no judge calls. */
function restoreEvaluation(evaluation: Evaluation, rubric: Rubric, recorded: Map<string, DecisionRating>): Evaluation {
  const restore = (r: Rating): Rating => {
    const original = recorded.get(r.criterionId);
    if (r.judgeType === "decision" && original?.raw) {
      const o = original.raw;
      const prefix = `${o.provider}${o.model ? `/${o.model}` : ""}`;
      return {
        ...r, rationale: r.rationale?.replace(/^mock\/replay/, prefix),
        raw: { ...r.raw, provider: o.provider, model: o.model, requestedModel: o.requestedModel, resolvedModel: o.resolvedModel, modelVerified: o.modelVerified, latencyMs: o.latencyMs, stateChars: o.stateChars, stateTruncated: o.stateTruncated },
      };
    }
    const escalated = escalatedFrom(r);
    return escalated ? ({ ...r, raw: { ...r.raw, escalatedFrom: restore(escalated) } } as Rating) : r;
  };
  return {
    ...evaluation, rubric,
    criteria: evaluation.criteria.map((c) => ({ ...c, ratings: c.ratings.map(restore) })),
    usage: { ...evaluation.usage, decisionCalls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

/** Judge types the criteria are scored with (named judges resolved). */
function judgeTypes(rubric: Rubric): string[] {
  const types = new Set<string>();
  const visit = (spec: unknown) => {
    const s = spec as { type?: string; ref?: string };
    if (s?.type === "ref" && s.ref) visit(rubric.judges[s.ref]);
    else if (s?.type) types.add(s.type);
  };
  for (const c of rubric.criteria) for (const j of [c.judge ?? rubric.defaultJudge].flat()) visit(j);
  return [...types];
}
