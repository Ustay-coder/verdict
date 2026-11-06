import { RetryableError, type Queue, type Job, type SerializableEvaluateRequest } from "./queue.js";
import { fingerprint } from "./idempotency.js";
import { Aggregation, parseRubric, type Criterion, type JudgeSpec, type Rubric } from "./schema/rubric.js";
import { Subject, type Evidence } from "./schema/subject.js";
import type { AggregateResult, CriterionResult, Evaluation, Rating } from "./schema/evaluation.js";
import { ingest, type IngestOptions } from "./ingest/index.js";
import { DecisionJudge, type SystemOneQuestion, buildJudge, newRatingId, type Judge, type JudgeContext } from "./judges/index.js";
import { aggregateCriteria, aggregateRatings, coerceScore, criterionScale, normalizeScore } from "./aggregate/index.js";
import { MemoryStore, type Store, type StoredRubric } from "./store/index.js";

export interface EngineOptions {
  queue?: Queue;
  retry?: { maxAttempts?: number; backoffMs?: (attempt: number) => number };
  idempotencyTtlMs?: number;
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
  idempotencyKey?: string;
  /** Original transport body, before defaults or shorthand expansion. */
  fingerprintBody?: unknown;
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
  /** Set by evaluateBatch: every evaluation of one batch shares it (leaderboards, `verdict watch`). */
  batchId?: string;
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
  readonly queue?: Queue;
  private maxAttempts: number;
  private backoffMs: (attempt: number) => number;
  readonly store: Store;
  private idempotencyTtlMs: number;
  private env: (n: string) => string | undefined;
  private fetchImpl: typeof fetch;
  private ingestOptions: IngestOptions;
  private concurrency: number;
  private webhookSecret?: string;
  private onEvent?: (e: EngineEvent) => void;

  constructor(opts: EngineOptions = {}) {
    this.queue = opts.queue;
    this.maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 5);
    this.backoffMs = opts.retry?.backoffMs ?? (attempt => Math.min(300_000, 2000 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4)));
    this.idempotencyTtlMs = opts.idempotencyTtlMs ?? 86_400_000;
    this.store = opts.store ?? new MemoryStore();
    this.env = opts.env ?? ((n) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[n]);
    // Never store the bare global: Workers throw "Illegal invocation" when fetch is called with a foreign `this`.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
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

  async evaluate(req: EvaluateRequest, queued?: Evaluation): Promise<Evaluation> {
    const started = Date.now();
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    const ev = initialEvaluation(req, rubric, rubricId);
    if (queued) { ev.job = { ...queued.job! }; ev.createdAt = queued.createdAt; ev.rubricId = queued.rubricId; if (queued.batchId) ev.batchId = queued.batchId; }
    await this.store.putEvaluation(queued ? structuredClone(ev) : ev);
    this.onEvent?.({ type: "evaluation.started", evaluation: ev });
    req.onStarted?.(ev);

    try {
      ev.evidence = await ingest(ev.subject, this.ingestOptions);
    } catch (e) {
      ev.status = "failed";
      ev.error = `ingestion failed: ${(e as Error).message}`;
      ev.usage.durationMs = Date.now() - started;
      ev.updatedAt = new Date().toISOString();
      if (!queued) await this.store.putEvaluation(ev);
      if (!queued) { this.onEvent?.({ type: "evaluation.failed", evaluation: ev }); await this.deliverWebhook(ev); }
      return ev;
    }

    if (rubric.checks?.length) {
      const judge = buildJudge(rubric.checksJudge ?? rubric.defaultJudge, rubric) as DecisionJudge;
      const criterion = rubric.criteria[0]!;
      const ctx: JudgeContext = { rubric, criterion, scale: criterionScale(rubric, criterion), evidence: ev.evidence, evaluationId: ev.id, env: this.env, fetch: this.fetchImpl, signal: req.signal, usage: ev.usage };
      const questions: Record<string, SystemOneQuestion> = Object.fromEntries(rubric.checks.map(c => [c.id, { type: "noul", instructions: c.question, criteria: c.criteria }]));
      try {
        const res = await judge.ask(ctx, questions);
        ev.checks = rubric.checks.map(c => {
          const probability = res.answers[c.id]?.noul;
          if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) return { id: c.id, probability: null, passed: false, action: c.action, message: c.message, error: `invalid answer for check ${c.id}` };
          return { id: c.id, probability, passed: (probability >= c.threshold) === c.expect, action: c.action, message: c.message };
        });
      } catch (e) {
        ev.checks = rubric.checks.map(c => ({ id: c.id, probability: null, passed: false, action: c.action, message: c.message, error: (e as Error).message }));
      }
      if (ev.checks.some(c => !c.passed && c.action === "abort")) {
        ev.criteria = rubric.criteria.map(c => ({ criterionId: c.id, name: c.name, weight: c.weight, group: c.group, status: "excluded", ratings: [], pending: 0 }));
        ev.aggregate = { ...emptyAggregate(rubric), partial: false, passed: false, excluded: rubric.criteria.map(c => c.id) };
        ev.status = "completed";
        ev.error = ev.checks.find(c => c.action === "abort" && c.error)?.error;
        applyChecks(ev);
        ev.usage.durationMs = Date.now() - started;
        ev.updatedAt = new Date().toISOString();
        if (!queued) await this.store.putEvaluation(ev);
        if (!queued) { this.onEvent?.({ type: "evaluation.completed", evaluation: ev }); await this.deliverWebhook(ev); }
        return ev;
      }
    }
    const usage = ev.usage;
    const ratingsByCriterion = new Map<string, Rating[]>();
    const expected = new Map<string, number>();

    // Build one context per (criterion, judge) and group batchable judges (decision models) by batch key + evidence.
    type Unit = { criterion: Criterion; judge: Judge; ctx: JudgeContext };
    const units: Unit[] = [];
    for (const criterion of rubric.criteria) {
      const judges = this.judgesFor(rubric, criterion);
      expected.set(criterion.id, judges.reduce((s, j) => s + j.expectedRatings(), 0));
      ratingsByCriterion.set(criterion.id, []);
      const evidence = criterion.inputs?.length ? ev.evidence.filter((e) => e.tags.some((t) => criterion.inputs!.includes(t)) || criterion.inputs!.includes(e.label)) : ev.evidence;
      for (const judge of judges) {
        units.push({ criterion, judge, ctx: { rubric, criterion, scale: criterionScale(rubric, criterion), evidence, evaluationId: ev.id, env: this.env, fetch: this.fetchImpl, signal: req.signal, usage } });
      }
    }
    const groups = new Map<string, Unit[]>();
    const singles: Unit[] = [];
    for (const u of units) {
      if (u.judge.rateMany && u.judge.batchKey) {
        const key = `${u.judge.batchKey()}|${u.ctx.evidence.map((e) => e.inputIndex).join(",")}`;
        groups.set(key, [...(groups.get(key) ?? []), u]);
      } else singles.push(u);
    }
    const jobs: Array<() => Promise<void>> = [
      ...[...groups.values()].map((g) => async () => {
        const m = await g[0]!.judge.rateMany!(g.map((u) => u.ctx));
        for (const u of g) ratingsByCriterion.get(u.criterion.id)!.push(...(m.get(u.criterion.id) ?? [{ ...ratingBaseFor(u), status: "error", error: "judge returned no rating" }]));
      }),
      ...singles.map((u) => async () => { ratingsByCriterion.get(u.criterion.id)!.push(...(await u.judge.rate(u.ctx))); }),
    ];
    await mapLimit(jobs, this.concurrency, (job) => job());
    for (const criterion of rubric.criteria) {
      this.onEvent?.({ type: "criterion.scored", evaluationId: ev.id, result: aggregateRatings(rubric, criterion, ratingsByCriterion.get(criterion.id)!, expected.get(criterion.id)!) });
    }

    ev.criteria = rubric.criteria.map((c) => aggregateRatings(rubric, c, ratingsByCriterion.get(c.id) ?? [], expected.get(c.id) ?? 0));
    this.finalize(ev);
    ev.usage.durationMs = Date.now() - started;
    if (!queued) await this.store.putEvaluation(ev);
    if (!queued) this.onEvent?.({ type: ev.status === "pending_human" ? "evaluation.pending_human" : ev.status === "failed" ? "evaluation.failed" : "evaluation.completed", evaluation: ev });
    if (!queued && (ev.status === "completed" || ev.status === "failed")) await this.deliverWebhook(ev);
    return ev;
  }

  private prepareQueued(ev: Evaluation) {
    ev.status = "queued";
    ev.job = { attempts: 0, maxAttempts: this.maxAttempts };
    ev.error = undefined;
    ev.updatedAt = new Date().toISOString();
    return ev;
  }

  private async enqueueDocument(ev: Evaluation): Promise<Evaluation> {
    if (!this.queue) throw new ValidationError("no queue configured");
    await this.store.putEvaluation(ev);
    const request: SerializableEvaluateRequest = { rubric: ev.rubric, subject: ev.subject, tenantId: ev.tenantId, metadata: ev.metadata, webhook: ev.webhook, idempotencyKey: ev.idempotencyKey };
    await this.queue.enqueue({ type: "evaluate", evaluationId: ev.id, request: JSON.parse(JSON.stringify(request)), attempt: 1 });
    return ev;
  }

  async enqueueEvaluation(req: EvaluateRequest): Promise<Evaluation> {
    if (!this.queue) throw new ValidationError("no queue configured");
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    return this.enqueueDocument(this.prepareQueued(initialEvaluation(req, rubric, rubricId)));
  }

  async enqueueEvaluationIdempotent(req: EvaluateRequest & { idempotencyKey: string }) {
    if (!this.queue) throw new ValidationError("no queue configured");
    const result = await this.runIdempotent(req, "evaluation", [req.subject], ev => this.enqueueDocument(ev), ev => this.prepareQueued(ev));
    return { evaluation: result.evaluations[0]!, replayed: result.replayed };
  }

  /** Reserve a fetchable document before handing work to a host's background lifetime. */
  async evaluateBackground(req: EvaluateRequest, background: (work: Promise<unknown>) => void) {
    const start = async (ev: Evaluation) => {
      const work = this.evaluate({ ...req, rubric: ev.rubric, subject: ev.subject, id: ev.id, batchId: ev.batchId });
      background(work);
      return ev;
    };
    if (req.idempotencyKey !== undefined) {
      const result = await this.runIdempotent({ ...req, idempotencyKey: req.idempotencyKey }, "evaluation", [req.subject], start);
      return { evaluation: result.evaluations[0]!, replayed: result.replayed };
    }
    const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
    const ev = initialEvaluation(req, rubric, rubricId);
    await this.store.putEvaluation(ev);
    return { evaluation: await start(ev), replayed: false };
  }

  async retryEvaluation(id: string, tenantId?: string): Promise<Evaluation> {
    const ev = await this.store.getEvaluation(id, tenantId);
    if (!ev) throw new NotFoundError(`evaluation ${id} not found`);
    if (ev.status !== "failed") throw new ConflictError("only failed evaluations can be retried");
    return this.enqueueDocument(this.prepareQueued(ev));
  }

  async processJob(job: Job): Promise<Evaluation> {
    let jobs = processingJobs.get(this.store);
    if (!jobs) { jobs = new Map(); processingJobs.set(this.store, jobs); }
    const key = JSON.stringify([job.request.tenantId, job.evaluationId]);
    const active = jobs.get(key);
    if (active) return active;
    const work = this.runJob(job);
    jobs.set(key, work);
    try { return await work; } finally { if (jobs.get(key) === work) jobs.delete(key); }
  }

  private async runJob(job: Job): Promise<Evaluation> {
    const previous = await this.store.getEvaluation(job.evaluationId, job.request.tenantId);
    if (!previous) throw new NotFoundError(`evaluation ${job.evaluationId} not found`);
    if (previous.status === "completed" || previous.status === "pending_human" || previous.job?.deadLettered) return previous;
    if (previous.status === "failed" && !transientErrors(previous)) return previous;
    previous.job = { ...previous.job, attempts: job.attempt, maxAttempts: previous.job?.maxAttempts ?? this.maxAttempts, nextAttemptAt: undefined };
    const ev = await this.evaluate({ ...job.request, rubric: previous.rubric, subject: previous.subject, id: previous.id }, previous);
    const message = transientErrors(ev);
    if (message) {
      ev.job!.lastError = message;
      if (job.attempt < ev.job!.maxAttempts) {
        const delay = this.backoffMs(job.attempt);
        ev.job!.nextAttemptAt = new Date(Date.now() + delay).toISOString();
        ev.status = "queued";
        await this.store.putEvaluation(ev);
        throw new RetryableError(message, delay);
      }
      ev.status = "failed";
      ev.job!.deadLettered = true;
      ev.error = message;
    }
    ev.job!.nextAttemptAt = undefined;
    await this.store.putEvaluation(ev);
    this.onEvent?.({ type: ev.status === "pending_human" ? "evaluation.pending_human" : ev.status === "failed" ? "evaluation.failed" : "evaluation.completed", evaluation: ev });
    if (ev.status === "completed" || ev.status === "failed") await this.deliverWebhook(ev);
    return ev;
  }

  /** Evaluate many subjects against one rubric and rank them. */
  async evaluateBatch(rubricRef: EvaluateRequest["rubric"], subjects: Array<Subject | Record<string, unknown>>, opts: Omit<EvaluateRequest, "rubric" | "subject"> = {}) {
    const { rubric } = await this.resolveRubric(rubricRef, opts.tenantId);
    const batchId = opts.batchId ?? newId("bat");
    const evaluations = await mapLimit(subjects, Math.max(1, Math.floor(this.concurrency / 2)), (subject) => this.evaluate({ ...opts, rubric, subject, batchId }));
    const ranking = rankEvaluations(evaluations);
    return { evaluations, ranking };
  }

  async evaluateIdempotent(req: EvaluateRequest & { idempotencyKey: string }) {
    const result = await this.runIdempotent(req, "evaluation", [req.subject]);
    return { evaluation: result.evaluations[0]!, replayed: result.replayed };
  }

  async evaluateBatchIdempotent(rubric: EvaluateRequest["rubric"], subjects: Array<Subject | Record<string, unknown>>, opts: Omit<EvaluateRequest, "rubric" | "subject"> & { idempotencyKey: string }) {
    const result = await this.runIdempotent({ ...opts, rubric, subject: {} }, "batch", subjects);
    return { ...result, ranking: rankEvaluations(result.evaluations) };
  }

  private async runIdempotent(req: EvaluateRequest & { idempotencyKey: string }, targetType: "evaluation" | "batch", subjects: Array<Subject | Record<string, unknown>>, after?: (ev: Evaluation) => Promise<Evaluation>, prepare: (ev: Evaluation) => Evaluation = ev => ev) {
    if (req.idempotencyKey.length < 1 || req.idempotencyKey.length > 255) throw new ValidationError("Idempotency key must contain 1–255 characters");
    const lockKey = JSON.stringify([req.tenantId ?? "", req.idempotencyKey]);
    let locks = idempotencyLocks.get(this.store);
    if (!locks) { locks = new Map(); idempotencyLocks.set(this.store, locks); }
    const previous = locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>(resolve => { release = resolve; });
    locks.set(lockKey, lock);
    await previous;
    try {
      const body = req.fingerprintBody ?? (targetType === "evaluation"
        ? { rubric: req.rubric, subject: req.subject, metadata: req.metadata, webhook: req.webhook }
        : { rubric: req.rubric, subjects, metadata: req.metadata, webhook: req.webhook });
      const hash = await fingerprint(body);
      for (;;) {
        const record = await this.store.getIdempotency(req.tenantId, req.idempotencyKey);
        if (record && Date.parse(record.expiresAt) > Date.now()) {
          const ids = record.targetType === "evaluation" ? [record.targetId!] : record.evaluationIds!;
          const evaluations = await Promise.all(ids.map(id => this.store.getEvaluation(id, req.tenantId)));
          if (evaluations.every((e): e is Evaluation => !!e)) {
            if (record.fingerprint !== hash || record.targetType !== targetType) throw new ConflictError("Idempotency key already used for a different request");
            return { evaluations, replayed: true };
          }
        }
        // Validate everything before reserving ids. No ingestion or judges run here.
        const { rubric, rubricId } = await this.resolveRubric(req.rubric, req.tenantId);
        subjects.forEach(subject => Subject.parse(subject));
        const ids = subjects.map(() => newId("eval"));
        const recordToStore = { tenantId: req.tenantId, key: req.idempotencyKey, fingerprint: hash, targetType,
          targetId: targetType === "evaluation" ? ids[0] : undefined, evaluationIds: targetType === "batch" ? ids : undefined,
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.idempotencyTtlMs).toISOString() };
        const batchId = targetType === "batch" ? newId("bat") : undefined;
        const initial = subjects.map((subject, i) => prepare(initialEvaluation({ ...req, subject, id: ids[i], batchId }, rubric, rubricId)));
        if (this.store.reserveIdempotency) {
          if (!await this.store.reserveIdempotency(recordToStore, initial)) continue;
        } else {
          await this.store.putIdempotency(recordToStore);
          for (const evaluation of initial) await this.store.putEvaluation(evaluation);
        }
        release();
        const evaluations = await mapLimit(subjects, Math.max(1, Math.floor(this.concurrency / 2)), (subject, i) => after ? after(initial[i]!) : this.evaluate({ ...req, rubric, subject, id: ids[i], batchId }));
        return { evaluations, replayed: false };
      }
    } finally {
      release();
      if (locks.get(lockKey) === lock) locks.delete(lockKey);
    }
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
      return prev.status === "excluded" ? prev : aggregateRatings(rubric, c, prev.ratings, prev.ratings.length);
    });
    const next: Evaluation = { ...ev, rubric, criteria, aggregate: aggregateCriteria(rubric, criteria, merged), updatedAt: new Date().toISOString() };
    applyChecks(next);
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
    applyChecks(ev);
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
    if (this.webhookSecret) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
      headers["verdict-signature"] = `sha256=${Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("")}`;
    }
    try { await this.fetchImpl(ev.webhook, { method: "POST", headers, body }); } catch { /* webhook failures never fail the evaluation */ }
  }
}

function applyChecks(ev: Evaluation) {
  for (const check of ev.checks ?? []) {
    if (!check.passed && check.action === "fail" && !check.error) {
      ev.aggregate.gates.push({ criterion: `check:${check.id}`, passed: false, message: check.message });
      ev.aggregate.passed = false;
    }
    if (!check.passed && check.action === "abort") {
      ev.aggregate.score = undefined;
      ev.aggregate.raw = undefined;
      ev.aggregate.passed = false;
      ev.aggregate.partial = false;
    }
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

function ratingBaseFor(u: { criterion: Criterion; judge: Judge }): Omit<Rating, "status"> {
  return { id: newRatingId(), criterionId: u.criterion.id, raterId: u.judge.id, judgeType: u.judge.type, createdAt: new Date().toISOString() };
}

export class NotFoundError extends Error { status = 404; }
export class ValidationError extends Error { status = 400; }

export function rankEvaluations(evaluations: Evaluation[]) {
  return evaluations
      .map((e, i) => ({ rank: 0, evaluationId: e.id, subject: e.subject.name ?? e.subject.id ?? `#${i + 1}`, score: e.aggregate.score, grade: e.aggregate.grade, passed: e.aggregate.passed, status: e.status }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .map((r, i) => ({ ...r, rank: i + 1 }));
}
export class ConflictError extends Error { status = 409; }

const idempotencyLocks = new WeakMap<Store, Map<string, Promise<void>>>();

function initialEvaluation(req: EvaluateRequest, rubric: Rubric, rubricId?: string): Evaluation {
  const now = new Date().toISOString();
  return {
    id: req.id ?? newId("eval"),
    idempotencyKey: req.idempotencyKey,
    tenantId: req.tenantId,
    rubricId,
    rubric,
    subject: Subject.parse(req.subject),
    evidence: [],
    status: "running",
    criteria: [],
    aggregate: emptyAggregate(rubric),
    pendingTasks: [],
    usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
    metadata: req.metadata,
    webhook: req.webhook,
    ...(req.batchId ? { batchId: req.batchId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function transientErrors(ev: Evaluation): string | undefined {
  const errors = [ev.status === "failed" ? ev.error : undefined, ...ev.criteria.flatMap(c => c.ratings.filter(r => r.status === "error").map(r => r.error))].filter((e): e is string => !!e);
  return errors.find(e => /\b(429|5\d\d)\b|rate limit|timeout|timed out|fetch failed|ECONNRESET|ENOTFOUND|overloaded/i.test(e));
}

const processingJobs = new WeakMap<Store, Map<string, Promise<Evaluation>>>();
