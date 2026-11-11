/**
 * Named rater slots and nested panels must remain consistent when the last human finishes.
 */
import { aggregateCriteria, aggregateRatings, coerceScore, criterionScale, normalizeScore, scaleRange } from "../aggregate/index.js";
import type { CriterionResult, Evaluation, Rating } from "../schema/evaluation.js";
import { Aggregation, type Rubric } from "../schema/rubric.js";

import { EngineJobs } from "./jobs.js";
import { applyChecks } from "./shared.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { type ScoreSubmission } from "./types.js";

/** Applies human scores and reaggregation; rejects invalid submissions or missing evaluations. */
export class EngineHuman extends EngineJobs {
  async submitScore(evaluationId: string, s: ScoreSubmission, tenantId?: string): Promise<Evaluation> {
    if (!evaluationId.trim() || !s.criterionId.trim() || !s.raterId.trim()) throw new ValidationError("evaluation, criterion and rater ids must not be empty");
    if (s.confidence !== undefined && (!Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1)) throw new ValidationError("confidence must be between 0 and 1");
    const ev = await this.requireEvaluation(evaluationId, tenantId);
    const criterion = ev.rubric.criteria.find((c) => c.id === s.criterionId);
    const result = ev.criteria.find((c) => c.criterionId === s.criterionId);
    if (!criterion || !result) throw new ValidationError(`unknown criterion ${s.criterionId}`);
    const scale = criterionScale(ev.rubric, criterion);
    const slot = this.selectHumanSlot(result, s);
    const choice = criterion.choices ? String(s.score) : undefined;
    if (choice !== undefined && !Object.hasOwn(criterion.choices!, choice)) throw new ValidationError(`unknown choice ${choice}`);
    const score = choice !== undefined ? criterion.values?.[choice] : coerceScore(s.score, scale);
    Object.assign(slot, {
      status: "scored",
      raterId: s.raterId,
      score,
      choice,
      normalized: score === undefined ? undefined : normalizeScore(score, scale),
      confidence: s.confidence ?? 1,
      rationale: s.rationale,
      createdAt: new Date(this.now()).toISOString(),
    } satisfies Partial<Rating>);
    this.reaggregateSubmission(ev, result, criterion);
    await this.persistSubmission(ev, s.criterionId);
    return ev;
  }

  async reaggregate(evaluationId: string, aggregation: Partial<Aggregation> | undefined, tenantId?: string, persist = true): Promise<Evaluation> {
    const ev = await this.requireEvaluation(evaluationId, tenantId);
    const merged = Aggregation.parse({ ...ev.rubric.aggregation, ...(aggregation ?? {}) });
    const rubric: Rubric = { ...ev.rubric, aggregation: merged };
    // why: excluded criteria stay excluded; reaggregation uses frozen ratings and never calls judges.
    const criteria = rubric.criteria.map(c => reaggregateCriterion(ev, rubric, c));
    const next: Evaluation = { ...ev, rubric, criteria, aggregate: aggregateCriteria(rubric, criteria, merged), updatedAt: new Date(this.now()).toISOString() };
    applyChecks(next);
    if (persist) await this.store.putEvaluation(next);
    return next;
  }

  private selectHumanSlot(result: CriterionResult, s: ScoreSubmission): Rating<"human"> {
    const pending = result.ratings.filter((r): r is Rating<"human"> => r.status === "pending" && r.judgeType === "human");
    if (!pending.length) throw new ValidationError(`criterion ${s.criterionId} has no pending human rating`);
    const allowed = pending[0]!.raw?.allowedRaters ?? [];
    if (allowed.length && !allowed.includes(s.raterId)) throw new ValidationError(`rater ${s.raterId} is not allowed for ${s.criterionId} (allowed: ${allowed.join(", ")})`);
    if (result.ratings.some((r) => r.status === "scored" && r.judgeType === "human" && r.raterId === s.raterId)) throw new ValidationError(`rater ${s.raterId} already scored ${s.criterionId}`);
    // why: preserve named assignments before consuming anonymous slots or a legacy unassigned placeholder.
    return pending.find((r) => r.raterId === s.raterId) ?? pending.find((r) => /#\d+$/.test(r.raterId)) ?? pending[0]!;
  }

  private reaggregateSubmission(ev: Evaluation, result: CriterionResult, criterion: Rubric["criteria"][number]) {
    this.recomputePanels(ev, result);
    const expected = result.ratings.filter(r => r.judgeType !== "panel" || r.status !== "pending").length;
    const index = ev.criteria.findIndex(c => c.criterionId === criterion.id);
    ev.criteria[index] = aggregateRatings(ev.rubric, criterion, result.ratings, Math.max(expected, result.ratings.length));
    this.finalize(ev);
  }

  private async persistSubmission(ev: Evaluation, criterionId: string) {
    await this.store.putEvaluation(ev);
    this.onEvent?.({ type: "criterion.scored", evaluationId: ev.id, result: ev.criteria.find(c => c.criterionId === criterionId)! });
    if (ev.status !== "completed") return;
    this.onEvent?.({ type: "evaluation.completed", evaluation: ev });
    await this.deliverWebhook(ev);
  }

  private async requireEvaluation(id: string, tenantId?: string): Promise<Evaluation> {
    const evaluation = await this.store.getEvaluation(id, tenantId);
    if (!evaluation) throw new NotFoundError(`evaluation ${id} not found`);
    return evaluation;
  }

  protected recomputePanels(ev: Evaluation, result: CriterionResult) {
    const folded = new Set<string>();
    for (const panel of result.ratings) {
      for (const id of resolvePanel(ev, result, panel)) folded.add(id);
    }
    result.ratings = result.ratings.filter(rating => !folded.has(rating.id));
  }
}

/** Resolve only complete panels; member ratings contribute once through the panel score. */
function resolvePanel(ev: Evaluation, result: CriterionResult, panel: Rating): string[] {
  if (panel.judgeType !== "panel" || panel.status !== "pending") return [];
  const memberIds = new Set((panel.raw?.members ?? []).map(member => member.id));
  const members = result.ratings.filter(rating => memberIds.has(rating.id));
  // why: folding an incomplete panel would discard the human slots still awaiting submissions.
  if (members.some(rating => rating.status === "pending")) return [];
  const scored = members.filter(rating => rating.status === "scored");
  if (!scored.length) {
    panel.status = "error";
    panel.error = "no panel member produced a score";
    return [];
  }
  // why: panel members can have different raw scales, so average in normalized units before converting back.
  const normalized = scored.reduce((sum, rating) => sum + rating.normalized!, 0) / scored.length;
  const criterion = ev.rubric.criteria.find(criterion => criterion.id === panel.criterionId)!;
  const scale = criterionScale(ev.rubric, criterion);
  const [min, max] = scaleRange(scale);
  panel.status = "scored";
  panel.normalized = normalized;
  panel.score = coerceScore(normalized * (max - min) + min, scale);
  panel.rationale = scored.map(rating => `[${rating.raterId}: ${rating.score}] ${rating.rationale ?? ""}`).join("\n");
  return members.filter(member => member !== panel).map(member => member.id);
}

function reaggregateCriterion(ev: Evaluation, rubric: Rubric, criterion: Rubric["criteria"][number]): CriterionResult {
  const previous = ev.criteria.find(result => result.criterionId === criterion.id);
  if (!previous) throw new ValidationError(`missing stored criterion ${criterion.id}`);
  if (previous.status === "excluded") return previous;
  return aggregateRatings(rubric, criterion, previous.ratings, previous.ratings.length);
}
