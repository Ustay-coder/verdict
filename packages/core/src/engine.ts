import { createHmac } from "node:crypto";
import { Aggregation, parseRubric, type Criterion, type JudgeSpec, type Rubric } from "./schema/rubric.js";
import { Subject, type Evidence } from "./schema/subject.js";
import type { AggregateResult, CriterionResult, Evaluation, Rating } from "./schema/evaluation.js";
import { ingest, type IngestOptions } from "./ingest/index.js";
import { buildJudge, type Judge, type JudgeContext } from "./judges/index.js";
import { aggregateCriteria, aggregateRatings, coerceScore, criterionScale, normalizeScore } from "./aggregate/index.js";
import { MemoryStore, type Store, type StoredRubric } from "./store/index.js";

export interface EngineOptions {
  store?: Store;
  env?: (name: string) => string | undefined;
  fetch?: typeof fetch;
  ingest?: IngestOptions;
  /** Max criteria scored concurrently per evaluation. */
  concurrency?: number;
  /** Secret used to sign webhook deliveries (header `verdict-signature`). */
  webhookSecret?: string;
  onEvent?: (event: EngineEvent) => void;
}

export type EngineEvent =
  | { type: "evaluation.started"; evaluation: Evaluation }
  | { type: "criterion.scored"; evaluationId: string; result: CriterionResult }
  | { type: "evaluation.completed"; evaluation: Evaluation }
  | { type: "evaluation.pending_human"; evaluation: Evaluation }
  | { type: "evaluation.failed"; evaluation: Evaluation };

export interface EvaluateRequest {
  /** Inline rubric or the id of a stored rubric. */
  rubric: Rubric | Record<string, unknown> | string;
  subject: Subject | Record<string, unknown>;
  tenantId?: string;
  metadata?: Record<string, unknown>;
  /** POSTed with the final evaluation when it completes (also when humans finish it later). */
  webhook?: string;
  signal?: AbortSignal;
  /** Pre-assigned evaluation id (lets callers return it before the run finishes). */
  id?: string;
  /** Called as soon as the evaluation record exists in the store. */
  onStarted?: (evaluation: Evaluation) => void;
}

export interface ScoreSubmission {
  criterionId: string;
  raterId: string;
  /** Number on the criterion scale, or an ordinal / binary label. */
  score: number | string;
  rationale?: string;
  confidence?: number;
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class Engine {
  readonly store: Store;
  private env: (n: string) => string | undefined;
  private fetchImpl: typeof fetch;
  private ingestOptions: IngestOptions;
  private concurrency: number;
  private webhookSecret?: string;
  private onEvent?: (e: EngineEvent) => void;

  constructor(opts: EngineOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.env = opts.env ?? ((n) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[n]);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.ingestOptions = { fetch: this.fetchImpl, ...opts.ingest };
    this.concurrency = opts.concurrency ?? 8;
    this.webhookSecret = opts.webhookSecret ?? this.env("VERDICT_WEBHOOK_SECRET");
    this.onEvent = opts.onEvent;
  }

  /* ---------------- rubrics ---------------- */

  async createRubric(input: unknown, tenantId?: string): Promise<StoredRubric> {
    const rubric = parseRubric(input);
    const now = new Date().toISOString();
    const stored: StoredRubric = { ...rubric, id: rubric.id ?? newId("rub"), tenantId, createdAt: now, updatedAt: now };
    await this.store.putRubric(stored);
    return stored;
  }

  async updateRubric(id: string, input: unknown, tenantId?: string): Promise<StoredRubric> {
    const existing = await this.store.getRubric(id, tenantId);
    if (!existing) throw new NotFoundError(`rubric ${id} not found`);
    const rubric = parseRubric({ ...(input as object), id });
    const stored: StoredRubric = { ...rubric, id, tenantId, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
    await this.store.putRubric(stored);
    return stored;
  }

  async resolveRubric(ref: EvaluateRequest["rubric"], tenantId?: string): Promise<{ rubric: Rubric; rubricId?: string }> {
    if (typeof ref === "string") {
      const r = await this.store.getRubric(ref, tenantId);
      if (!r) throw new NotFoundError(`rubric ${ref} not found`);
      return { rubric: r, rubricId: r.id };
    }
    const rubric = parseRubric(ref);
    return { rubric, rubricId: rubric.id };
  }

  /* ---------------- evaluation ---------------- */

  async evaluate(req: EvaluateRequest): Promise<Evaluation> {
    const started = Date.now();
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    const subject = Subject.parse(req.subject);
    const now = new Date().toISOString();
    const ev: Evaluation = {
      id: req.id ?? newId("eval"),
      tenantId: req.tenantId,
      rubricId,
      rubric,
      subject,
      evidence: [],
      status: "running",
      criteria: [],
      aggregate: emptyAggregate(rubric),
      pendingTasks: [],
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      metadata: req.metadata,
      webhook: req.webhook,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putEvaluation(ev);
    this.onEvent?.({ type: "evaluation.started", evaluation: ev });
    req.onStarted?.(ev);

    try {
      ev.evidence = await ingest(subject, this.ingestOptions);
    } catch (e) {
      ev.status = "failed";
      ev.error = `ingestion failed: ${(e as Error).message}`;
      ev.usage.durationMs = Date.now() - started;
      ev.updatedAt = new Date().toISOString();
      await this.store.putEvaluation(ev);
      this.onEvent?.({ type: "evaluation.failed", evaluation: ev });
      return ev;
    }

    const usage = ev.usage;
    const ratingsByCriterion = new Map<string, Rating[]>();
    const expected = new Map<string, number>();

    await mapLimit(rubric.criteria, this.concurrency, async (criterion) => {
      const judges = this.judgesFor(rubric, criterion);
      expected.set(criterion.id, judges.reduce((s, j) => s + j.expectedRatings(), 0));
      const ctx: JudgeContext = {
        rubric, criterion,
        scale: criterionScale(rubric, criterion),
        evidence: criterion.inputs?.length ? ev.evidence.filter((e) => e.tags.some((t) => criterion.inputs!.includes(t)) || criterion.inputs!.includes(e.label)) : ev.evidence,
        evaluationId: ev.id,
        env: this.env,
        fetch: this.fetchImpl,
        signal: req.signal,
        usage,
      };
      const ratings = (await Promise.all(judges.map((j) => j.rate(ctx)))).flat();
      ratingsByCriterion.set(criterion.id, ratings);
      this.onEvent?.({ type: "criterion.scored", evaluationId: ev.id, result: aggregateRatings(rubric, criterion, ratings, expected.get(criterion.id)!) });
    });

    ev.criteria = rubric.criteria.map((c) => aggregateRatings(rubric, c, ratingsByCriterion.get(c.id) ?? [], expected.get(c.id) ?? 0));
    this.finalize(ev);
    ev.usage.durationMs = Date.now() - started;
    await this.store.putEvaluation(ev);
    this.onEvent?.({ type: ev.status === "pending_human" ? "evaluation.pending_human" : ev.status === "failed" ? "evaluation.failed" : "evaluation.completed", evaluation: ev });
    if (ev.status === "completed" || ev.status === "failed") await this.deliverWebhook(ev);
    return ev;
  }

  /** Evaluate many subjects against one rubric and rank them. */
  async evaluateBatch(rubricRef: EvaluateRequest["rubric"], subjects: Array<Subject | Record<string, unknown>>, opts: Omit<EvaluateRequest, "rubric" | "subject"> = {}) {
    const { rubric } = await this.resolveRubric(rubricRef, opts.tenantId);
    const evaluations = await mapLimit(subjects, Math.max(1, Math.floor(this.concurrency / 2)), (subject) => this.evaluate({ ...opts, rubric, subject }));
    const ranking = evaluations
      .map((e, i) => ({ rank: 0, evaluationId: e.id, subject: e.subject.name ?? e.subject.id ?? `#${i + 1}`, score: e.aggregate.score, grade: e.aggregate.grade, passed: e.aggregate.passed, status: e.status }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .map((r, i) => ({ ...r, rank: i + 1 }));
    return { evaluations, ranking };
  }

  /** Human rater submits a score for a pending criterion. */
  async submitScore(evaluationId: string, s: ScoreSubmission, tenantId?: string): Promise<Evaluation> {
    const ev = await this.store.getEvaluation(evaluationId, tenantId);
    if (!ev) throw new NotFoundError(`evaluation ${evaluationId} not found`);
    const criterion = ev.rubric.criteria.find((c) => c.id === s.criterionId);
    const result = ev.criteria.find((c) => c.criterionId === s.criterionId);
    if (!criterion || !result) throw new ValidationError(`unknown criterion ${s.criterionId}`);
    const scale = criterionScale(ev.rubric, criterion);
    const pending = result.ratings.filter((r) => r.status === "pending" && r.judgeType === "human");
    if (!pending.length) throw new ValidationError(`criterion ${s.criterionId} has no pending human rating`);
    const allowed = (pending[0]!.raw?.allowedRaters as string[] | undefined) ?? [];
    if (allowed.length && !allowed.includes(s.raterId)) throw new ValidationError(`rater ${s.raterId} is not allowed for ${s.criterionId} (allowed: ${allowed.join(", ")})`);
    if (result.ratings.some((r) => r.status === "scored" && r.judgeType === "human" && r.raterId === s.raterId)) throw new ValidationError(`rater ${s.raterId} already scored ${s.criterionId}`);
    const slot = pending.find((r) => r.raterId === s.raterId) ?? pending.find((r) => /#\d+$/.test(r.raterId)) ?? pending[0]!;
    const score = coerceScore(s.score, scale);
    Object.assign(slot, {
      status: "scored",
      raterId: s.raterId,
      score,
      normalized: normalizeScore(score, scale),
      confidence: s.confidence ?? 1,
      rationale: s.rationale,
      createdAt: new Date().toISOString(),
    } satisfies Partial<Rating>);
    // Panel placeholders wrapping this human become resolvable once all members are in — recompute panels.
    this.recomputePanels(ev, result);
    const expected = result.ratings.filter((r) => r.judgeType !== "panel" || r.status !== "pending").length;
    const idx = ev.criteria.findIndex((c) => c.criterionId === s.criterionId);
    ev.criteria[idx] = aggregateRatings(ev.rubric, criterion, result.ratings, Math.max(expected, result.ratings.length));
    this.finalize(ev);
    await this.store.putEvaluation(ev);
    this.onEvent?.({ type: "criterion.scored", evaluationId: ev.id, result: ev.criteria[idx]! });
    if (ev.status === "completed") { this.onEvent?.({ type: "evaluation.completed", evaluation: ev }); await this.deliverWebhook(ev); }
    return ev;
  }

  /** Re-run only the aggregation step with a different aggregation config. No judges are re-invoked. */
  async reaggregate(evaluationId: string, aggregation: Partial<Aggregation> | undefined, tenantId?: string, persist = true): Promise<Evaluation> {
    const ev = await this.store.getEvaluation(evaluationId, tenantId);
    if (!ev) throw new NotFoundError(`evaluation ${evaluationId} not found`);
    const merged = Aggregation.parse({ ...ev.rubric.aggregation, ...(aggregation ?? {}) });
    const rubric: Rubric = { ...ev.rubric, aggregation: merged };
    const criteria = rubric.criteria.map((c) => {
      const prev = ev.criteria.find((r) => r.criterionId === c.id)!;
      return aggregateRatings(rubric, c, prev.ratings, prev.ratings.length);
    });
    const next: Evaluation = { ...ev, rubric, criteria, aggregate: aggregateCriteria(rubric, criteria, merged), updatedAt: new Date().toISOString() };
    if (persist) await this.store.putEvaluation(next);
    return next;
  }

  /* ---------------- internals ---------------- */

  private judgesFor(rubric: Rubric, c: Criterion): Judge[] {
    const specs: JudgeSpec[] = Array.isArray(c.judge) ? c.judge : c.judge ? [c.judge] : [rubric.defaultJudge];
    return specs.map((s) => buildJudge(s, rubric));
  }

  private recomputePanels(ev: Evaluation, result: CriterionResult) {
    for (const r of result.ratings) {
      if (r.judgeType !== "panel" || r.status !== "pending") continue;
      const members = (r.raw?.members as Rating[] | undefined) ?? [];
      const ids = new Set(members.map((m) => m.id));
      const live = result.ratings.filter((x) => ids.has(x.id));
      if (live.some((x) => x.status === "pending")) continue;
      const scored = live.filter((x) => x.status === "scored");
      if (!scored.length) { r.status = "error"; r.error = "no panel member produced a score"; continue; }
      const n = scored.reduce((s, x) => s + x.normalized!, 0) / scored.length;
      const scale = criterionScale(ev.rubric, ev.rubric.criteria.find((c) => c.id === r.criterionId)!);
      const [lo, hi] = [normalizeScore(0, scale), 1];
      void lo; void hi;
      r.status = "scored";
      r.normalized = n;
      r.score = coerceScore(n * (scaleTop(scale) - scaleBottom(scale)) + scaleBottom(scale), scale);
      r.rationale = scored.map((x) => `[${x.raterId}: ${x.score}] ${x.rationale ?? ""}`).join("\n");
      // Member ratings fold into the panel; hide them from the rater aggregation.
      for (const m of live) if (m !== r) (m as Rating & { folded?: boolean }).folded = true;
    }
    result.ratings = result.ratings.filter((x) => !(x as Rating & { folded?: boolean }).folded);
  }

  private finalize(ev: Evaluation) {
    ev.aggregate = aggregateCriteria(ev.rubric, ev.criteria);
    ev.pendingTasks = ev.criteria.flatMap((c) =>
      c.ratings.filter((r) => r.status === "pending" && r.judgeType === "human").map((r) => ({ criterionId: c.criterionId, raterId: /#\d+$/.test(r.raterId) ? undefined : r.raterId, allowedRaters: (r.raw?.allowedRaters as string[] | undefined)?.length ? (r.raw?.allowedRaters as string[]) : undefined, instructions: r.raw?.instructions as string | undefined })),
    );
    const anyPending = ev.criteria.some((c) => c.status === "pending");
    const allErrored = ev.criteria.length > 0 && ev.criteria.every((c) => c.status === "error");
    ev.status = allErrored ? "failed" : anyPending ? "pending_human" : "completed";
    if (allErrored) ev.error = "every criterion failed to score";
    ev.updatedAt = new Date().toISOString();
  }

  private async deliverWebhook(ev: Evaluation) {
    if (!ev.webhook) return;
    const body = JSON.stringify({ type: `evaluation.${ev.status}`, data: ev });
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "verdict-webhooks/0.1" };
    if (this.webhookSecret) headers["verdict-signature"] = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
    try { await this.fetchImpl(ev.webhook, { method: "POST", headers, body }); } catch { /* webhook failures never fail the evaluation */ }
  }
}

function scaleBottom(scale: Rubric["scale"]) { return scale.type === "numeric" ? scale.min : scale.type === "ordinal" ? Math.min(...(scale.values ?? scale.labels.map((_, i) => i))) : 0; }
function scaleTop(scale: Rubric["scale"]) { return scale.type === "numeric" ? scale.max : scale.type === "ordinal" ? Math.max(...(scale.values ?? scale.labels.map((_, i) => i))) : 1; }

function emptyAggregate(rubric: Rubric): AggregateResult {
  return { method: rubric.aggregation.method, range: rubric.aggregation.normalize === false ? null : rubric.aggregation.normalize, gates: [], partial: true, included: [], excluded: [] };
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  });
  await Promise.all(workers);
  return out;
}

export class NotFoundError extends Error { status = 404; }
export class ValidationError extends Error { status = 400; }
