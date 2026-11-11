/**
 * Tenant context flows to every engine/store operation; validation failures use the shared HTTP error mapper.
 */
import { NotFoundError, calibrate, parseRubric } from "@verdict-ai/core";
import { Hono } from "hono";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { readRubricBody, tenant } from "./shared.js";

/** Registers rubrics operations; handler failures propagate to the transport error boundary. */
export function registerRubrics(app: Hono<Env>, { engine }: AppOptions) {
  /* ---------- rubrics ---------- */
  app.post("/v1/rubrics", async (c) => {
    const body = await readRubricBody(c.req.raw);
    const r = await engine.createRubric(body, tenant(c));
    return c.json(r, 201);
  });
  app.post("/v1/rubrics/validate", async (c) => {
    try { const r = parseRubric(await readRubricBody(c.req.raw)); return c.json({ valid: true, rubric: r }); }
    // why: validation is a diagnostic endpoint; invalid rubrics are successful diagnostic responses.
    catch (e) { return c.json({ valid: false, error: e instanceof z.ZodError ? e.issues : (e as Error).message }, 200); }
  });
  app.get("/v1/rubrics", async (c) => c.json({ data: await engine.store.listRubrics({ tenantId: tenant(c), limit: Number(c.req.query("limit") ?? 100) }) }));
  app.get("/v1/rubrics/:id", async (c) => {
    const r = await engine.store.getRubric(c.req.param("id"), tenant(c));
    if (!r) throw new NotFoundError(`rubric ${c.req.param("id")} not found`);
    return c.json(r);
  });
  app.get("/v1/rubrics/:id/calibration", async (c) => {
    const rubricId = c.req.param("id"), tenantId = tenant(c);
    if (!(await engine.store.getRubric(rubricId, tenantId))) throw new NotFoundError(`rubric ${rubricId} not found`);
    const options = z.object({
      target: z.coerce.number().min(0).max(1).default(0.8),
      buckets: z.coerce.number().int().min(1).max(1000).default(5),
      limit: z.coerce.number().int().min(1).default(1000),
    }).parse(c.req.query());
    return c.json(calibrate(await engine.store.listEvaluations({ tenantId, rubricId, limit: options.limit }), options));
  });
  app.put("/v1/rubrics/:id", async (c) => c.json(await engine.updateRubric(c.req.param("id"), await readRubricBody(c.req.raw), tenant(c))));
  app.delete("/v1/rubrics/:id", async (c) => {
    if (!(await engine.store.deleteRubric(c.req.param("id"), tenant(c)))) throw new NotFoundError(`rubric ${c.req.param("id")} not found`);
    return c.body(null, 204);
  });

}
