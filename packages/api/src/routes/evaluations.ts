/**
 * Tenant context flows to every engine/store operation; validation failures use the shared HTTP error mapper.
 */
import { Aggregation, Engine, NotFoundError, Rubric, Subject, ValidationError } from "@verdict-ai/core";
import { Hono, type Context } from "hono";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { present } from "../present.js";
import { readIdempotencyKey, tenant } from "./shared.js";

// why: the inbox is bounded independently of ordinary listings so pending tasks remain useful without unbounded reads.
const TASK_INBOX_LIMIT = 500;

/** Registers evaluations operations; handler failures propagate to the transport error boundary. */
export function registerEvaluations(app: Hono<Env>, { engine, allowAsync, background }: AppOptions) {
  /* ---------- evaluations ---------- */
  app.post("/v1/evaluations", async (c) => {
    const parsed = await parseEvaluateBody(c);
    const { body } = parsed;
    if (body.async && allowAsync) return respondAsync(c, engine, parsed, background);
    return respondSync(c, engine, parsed);
  });

  app.get("/v1/evaluations", async (c) => {
    const list = await engine.store.listEvaluations({ tenantId: tenant(c), rubricId: c.req.query("rubric"), status: c.req.query("status"), limit: Number(c.req.query("limit") ?? 50) });
    return c.json({ data: list.map((e) => present(e, { ratings: false })) });
  });
  app.get("/v1/evaluations/:id", async (c) => {
    const ev = await engine.store.getEvaluation(c.req.param("id"), tenant(c));
    if (!ev) throw new NotFoundError(`evaluation ${c.req.param("id")} not found`);
    return c.json(present(ev, { evidence: c.req.query("evidence") === "true" }));
  });

  app.post("/v1/evaluations/:id/retry", async c => {
    const ev = await engine.retryEvaluation(c.req.param("id"), tenant(c));
    return c.json({ id: ev.id, status: "queued", url: `/v1/evaluations/${ev.id}` }, 202);
  });

  const ScoreBody = z.object({ criterionId: z.string(), raterId: z.string(), score: z.union([z.number(), z.string()]), rationale: z.string().optional(), confidence: z.number().min(0).max(1).optional() });
  app.post("/v1/evaluations/:id/scores", async (c) => {
    const body = ScoreBody.parse(await c.req.json());
    return c.json(present(await engine.submitScore(c.req.param("id"), body, tenant(c))));
  });
  /** Human task inbox: everything waiting on a rater. */
  app.get("/v1/tasks", async (c) => {
    const rater = c.req.query("rater");
    const list = await engine.store.listEvaluations({ tenantId: tenant(c), status: "pending_human", limit: TASK_INBOX_LIMIT });
    const tasks = list.flatMap((e) => e.pendingTasks.filter((t) => !rater || (t.raterId ? t.raterId === rater : !t.allowedRaters || t.allowedRaters.includes(rater))).map((t) => ({ evaluationId: e.id, rubric: e.rubric.name, subject: e.subject.name, ...t })));
    return c.json({ data: tasks });
  });

  app.post("/v1/evaluations/:id/aggregate", async (c) => {
    const body = z.object({ aggregation: Aggregation.partial(), persist: z.boolean().default(false) }).parse(await c.req.json());
    return c.json(present(await engine.reaggregate(c.req.param("id"), body.aggregation, tenant(c), body.persist)));
  });

}

const EvaluateBody = z.object({
  rubric: z.union([z.string(), Rubric]),
  subject: Subject.optional(),
  /** Shorthand: inputs at top level instead of subject.inputs. */
  inputs: Subject.shape.inputs.optional(),
  name: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  webhook: z.string().url().optional(),
  async: z.boolean().optional(),
  /** Include full evidence text in the response. */
  includeEvidence: z.boolean().optional(),
});

async function parseEvaluateBody(c: Context<Env>) {
  const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
  const body = EvaluateBody.parse(raw);
  const idempotencyKey = readIdempotencyKey(c.req.raw);
  // why: transport-only flags do not change evaluation identity; hash only scoring inputs and delivery metadata.
  const fingerprintBody = Object.fromEntries(["rubric", "subject", "inputs", "name", "metadata", "webhook"].filter(k => k in raw).map(k => [k, raw[k]]));
  const subject = body.subject ?? { name: body.name, inputs: body.inputs ?? [] };
  if (!subject.inputs?.length) throw new ValidationError("provide `subject.inputs` or `inputs`");
  const req = { rubric: body.rubric, subject, tenantId: tenant(c), metadata: body.metadata, webhook: body.webhook };
  return { body, req, idempotencyKey, fingerprintBody };
}
type Parsed = Awaited<ReturnType<typeof parseEvaluateBody>>;
async function respondAsync(c: Context<Env>, engine: Engine, { req, idempotencyKey, fingerprintBody }: Parsed, background: AppOptions["background"]) {
  // why: durable queues own retries; the background fallback is for deployments without a queue binding.
  if (engine.queue) {
    const result = idempotencyKey === undefined
      ? { evaluation: await engine.enqueueEvaluation(req), replayed: false }
      : await engine.enqueueEvaluationIdempotent({ ...req, idempotencyKey, fingerprintBody });
    // why: a replay returns the existing resource with 200 instead of claiming a new job was accepted.
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json({ id: result.evaluation.id, status: result.evaluation.status, url: `/v1/evaluations/${result.evaluation.id}` }, result.replayed ? 200 : 202);
  }
  {
    const result = await engine.evaluateBackground({ ...req, idempotencyKey, fingerprintBody }, background ?? (work => { void work.catch(error => console.error("Background evaluation failed", error)); }));
    if (result.replayed) c.header("Idempotency-Replayed", "true");
    return c.json({ id: result.evaluation.id, status: result.replayed ? result.evaluation.status : "queued", url: `/v1/evaluations/${result.evaluation.id}` }, result.replayed ? 200 : 202);
  }

}
async function respondSync(c: Context<Env>, engine: Engine, { req, idempotencyKey, fingerprintBody, body }: Parsed) {
  const includeEvidence = body.includeEvidence;
  if (idempotencyKey !== undefined) {
    const { evaluation, replayed } = await engine.evaluateIdempotent({ ...req, idempotencyKey, fingerprintBody });
    if (replayed) c.header("Idempotency-Replayed", "true");
    return c.json(present(evaluation, { evidence: includeEvidence }), replayed ? 200 : evaluation.status === "failed" ? 422 : 201);
  }
  const ev = await engine.evaluate(req);
  return c.json(present(ev, { evidence: includeEvidence }), ev.status === "failed" ? 422 : 201);
}
