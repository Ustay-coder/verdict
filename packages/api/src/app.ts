import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Aggregation, Engine, NotFoundError, Rubric, Subject, ValidationError, newId, parseRubric, loadRubricText, type Evaluation } from "@verdict/core";

export interface Auth {
  /** Map an API key to a tenant id, or undefined to reject. Return "" for single-tenant open mode. */
  resolve(apiKey: string | undefined): Promise<string | undefined> | string | undefined;
}

/** `VERDICT_API_KEYS="key1:tenantA,key2:tenantB"`; a bare key maps to tenant "default". Unset = open (single tenant). */
export function envAuth(env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}): Auth {
  const raw = env.VERDICT_API_KEYS?.trim();
  if (!raw) return { resolve: () => "default" };
  const keys = new Map(raw.split(",").map((pair) => { const [k, t] = pair.trim().split(":"); return [k!, t ?? "default"] as const; }));
  return { resolve: (k) => (k ? keys.get(k) : undefined) };
}

/** Optional API-key management (backed by @verdict/db's DrizzleAuth). Exposed under /v1/admin with VERDICT_ADMIN_KEY. */
export interface KeyManager {
  createKey(tenantId: string, name: string): Promise<{ id: string; key: string; prefix: string }>;
  revokeKey(id: string, tenantId?: string): Promise<boolean>;
  listKeys(tenantId: string): Promise<Array<{ id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>>;
}

export interface AppOptions {
  engine: Engine;
  auth?: Auth;
  keys?: KeyManager;
  /** Bearer token for /v1/admin/* (default: env VERDICT_ADMIN_KEY). Unset = admin routes disabled. */
  adminKey?: string;
  /** Return 202 immediately and finish in the background when the client asks (`"async": true`). */
  allowAsync?: boolean;
  log?: boolean;
}

type Env = { Variables: { tenantId: string } };

/** Public view of an evaluation: strip bulky evidence text unless asked. */
export function present(ev: Evaluation, { evidence = false, ratings = true } = {}) {
  return {
    ...ev,
    rubric: { id: ev.rubric.id, name: ev.rubric.name, version: ev.rubric.version, aggregation: ev.rubric.aggregation },
    evidence: evidence ? ev.evidence : ev.evidence.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
    criteria: ratings ? ev.criteria : ev.criteria.map(({ ratings: _r, ...c }) => c),
  };
}

export function createApp({ engine, auth = envAuth(), keys, adminKey = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.VERDICT_ADMIN_KEY, allowAsync = true, log = false }: AppOptions) {
  const app = new Hono<Env>();
  if (log) app.use(logger());
  app.use("*", cors());

  app.get("/", (c) => c.json({ name: "verdict", version: "0.1.0", docs: "/v1/openapi.json" }));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  app.get("/v1/openapi.json", (c) => c.json(openapi));

  /* ---------- admin: API keys ---------- */
  app.use("/v1/admin/*", async (c, next) => {
    if (!adminKey || !keys) throw new HTTPException(404, { message: "admin API disabled (set VERDICT_ADMIN_KEY and a database-backed key store)" });
    const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (header !== adminKey) throw new HTTPException(401, { message: "invalid admin key" });
    await next();
  });
  app.post("/v1/admin/keys", async (c) => {
    const body = z.object({ tenantId: z.string().min(1), name: z.string().min(1) }).parse(await c.req.json());
    return c.json(await keys!.createKey(body.tenantId, body.name), 201);
  });
  app.get("/v1/admin/keys", async (c) => {
    const tenantId = c.req.query("tenant");
    if (!tenantId) throw new ValidationError("query param `tenant` is required");
    return c.json({ data: await keys!.listKeys(tenantId) });
  });
  app.delete("/v1/admin/keys/:id", async (c) => {
    if (!(await keys!.revokeKey(c.req.param("id")))) throw new NotFoundError(`key ${c.req.param("id")} not found`);
    return c.body(null, 204);
  });

  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/health" || c.req.path === "/v1/openapi.json" || c.req.path.startsWith("/v1/admin/")) return next();
    const header = c.req.header("authorization");
    const key = header?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key");
    const tenant = await auth.resolve(key);
    if (tenant === undefined) throw new HTTPException(401, { message: "invalid or missing API key" });
    c.set("tenantId", tenant);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: { type: "http", message: err.message } }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: { type: "validation", message: "invalid request", issues: err.issues } }, 400);
    if (err instanceof NotFoundError) return c.json({ error: { type: "not_found", message: err.message } }, 404);
    if (err instanceof ValidationError) return c.json({ error: { type: "validation", message: err.message } }, 400);
    const message = (err as Error).message ?? "internal error";
    const status = /duplicate|unknown|requires|must/i.test(message) ? 400 : 500;
    return c.json({ error: { type: status === 400 ? "validation" : "internal", message } }, status);
  });

  const tenant = (c: { get(k: "tenantId"): string }) => c.get("tenantId") || undefined;

  /* ---------- rubrics ---------- */
  app.post("/v1/rubrics", async (c) => {
    const body = await readRubricBody(c.req.raw);
    const r = await engine.createRubric(body, tenant(c));
    return c.json(r, 201);
  });
  app.post("/v1/rubrics/validate", async (c) => {
    try { const r = parseRubric(await readRubricBody(c.req.raw)); return c.json({ valid: true, rubric: r }); }
    catch (e) { return c.json({ valid: false, error: e instanceof z.ZodError ? e.issues : (e as Error).message }, 200); }
  });
  app.get("/v1/rubrics", async (c) => c.json({ data: await engine.store.listRubrics({ tenantId: tenant(c), limit: Number(c.req.query("limit") ?? 100) }) }));
  app.get("/v1/rubrics/:id", async (c) => {
    const r = await engine.store.getRubric(c.req.param("id"), tenant(c));
    if (!r) throw new NotFoundError(`rubric ${c.req.param("id")} not found`);
    return c.json(r);
  });
  app.put("/v1/rubrics/:id", async (c) => c.json(await engine.updateRubric(c.req.param("id"), await readRubricBody(c.req.raw), tenant(c))));
  app.delete("/v1/rubrics/:id", async (c) => {
    if (!(await engine.store.deleteRubric(c.req.param("id"), tenant(c)))) throw new NotFoundError(`rubric ${c.req.param("id")} not found`);
    return c.body(null, 204);
  });

  /* ---------- evaluations ---------- */
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

  app.post("/v1/evaluations", async (c) => {
    const body = EvaluateBody.parse(await c.req.json());
    const subject = body.subject ?? { name: body.name, inputs: body.inputs ?? [] };
    if (!subject.inputs?.length) throw new ValidationError("provide `subject.inputs` or `inputs`");
    const req = { rubric: body.rubric as string | Record<string, unknown>, subject, tenantId: tenant(c), metadata: body.metadata, webhook: body.webhook };
    if (body.async && allowAsync) {
      // Resolve the rubric now so a bad reference fails synchronously, then run in the background.
      await engine.resolveRubric(req.rubric, req.tenantId);
      const id = newId("eval");
      await new Promise<void>((resolve) => {
        engine.evaluate({ ...req, id, onStarted: () => resolve() }).catch(() => resolve());
      });
      return c.json({ id, status: "queued", url: `/v1/evaluations/${id}` }, 202);
    }
    const ev = await engine.evaluate(req);
    return c.json(present(ev, { evidence: body.includeEvidence }), ev.status === "failed" ? 422 : 201);
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

  const ScoreBody = z.object({ criterionId: z.string(), raterId: z.string(), score: z.union([z.number(), z.string()]), rationale: z.string().optional(), confidence: z.number().min(0).max(1).optional() });
  app.post("/v1/evaluations/:id/scores", async (c) => {
    const body = ScoreBody.parse(await c.req.json());
    return c.json(present(await engine.submitScore(c.req.param("id"), body, tenant(c))));
  });
  /** Human task inbox: everything waiting on a rater. */
  app.get("/v1/tasks", async (c) => {
    const rater = c.req.query("rater");
    const list = await engine.store.listEvaluations({ tenantId: tenant(c), status: "pending_human", limit: 500 });
    const tasks = list.flatMap((e) => e.pendingTasks.filter((t) => !rater || (t.raterId ? t.raterId === rater : !t.allowedRaters || t.allowedRaters.includes(rater))).map((t) => ({ evaluationId: e.id, rubric: e.rubric.name, subject: e.subject.name, ...t })));
    return c.json({ data: tasks });
  });

  app.post("/v1/evaluations/:id/aggregate", async (c) => {
    const body = z.object({ aggregation: Aggregation.partial(), persist: z.boolean().default(false) }).parse(await c.req.json());
    return c.json(present(await engine.reaggregate(c.req.param("id"), body.aggregation, tenant(c), body.persist)));
  });

  /* ---------- batches (leaderboards) ---------- */
  app.post("/v1/batches", async (c) => {
    const body = z.object({ rubric: z.union([z.string(), Rubric]), subjects: z.array(Subject).min(1), metadata: z.record(z.string(), z.unknown()).optional(), webhook: z.string().url().optional() }).parse(await c.req.json());
    const { evaluations, ranking } = await engine.evaluateBatch(body.rubric as string | Record<string, unknown>, body.subjects, { tenantId: tenant(c), metadata: body.metadata, webhook: body.webhook });
    return c.json({ ranking, evaluations: evaluations.map((e) => present(e, { ratings: false })) }, 201);
  });

  return app;
}

async function readRubricBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (ct.includes("yaml") || ct.includes("text/plain")) return loadRubricText(text);
  return JSON.parse(text);
}

const openapi = {
  openapi: "3.1.0",
  info: { title: "Verdict Evaluation API", version: "0.1.0", description: "Customizable rubrics, pluggable judges (LLM / human / benchmark), customizable aggregation." },
  servers: [{ url: "/" }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/v1/rubrics": { post: { summary: "Create rubric (JSON or YAML body)" }, get: { summary: "List rubrics" } },
    "/v1/rubrics/validate": { post: { summary: "Validate a rubric without storing it" } },
    "/v1/rubrics/{id}": { get: { summary: "Get rubric" }, put: { summary: "Replace rubric" }, delete: { summary: "Delete rubric" } },
    "/v1/evaluations": { post: { summary: "Evaluate a subject (sync; `async:true` for 202)" }, get: { summary: "List evaluations" } },
    "/v1/evaluations/{id}": { get: { summary: "Get evaluation (`?evidence=true` for full text)" } },
    "/v1/evaluations/{id}/scores": { post: { summary: "Submit a human score for a pending criterion" } },
    "/v1/evaluations/{id}/aggregate": { post: { summary: "Re-aggregate with a different aggregation config (no re-judging)" } },
    "/v1/tasks": { get: { summary: "Pending human-rating tasks (`?rater=`)" } },
    "/v1/batches": { post: { summary: "Evaluate many subjects against one rubric and rank them" } },
    "/v1/admin/keys": { post: { summary: "Create an API key for a tenant (admin)" }, get: { summary: "List a tenant's keys (admin, `?tenant=`)" } },
    "/v1/admin/keys/{id}": { delete: { summary: "Revoke a key (admin)" } },
  },
};
