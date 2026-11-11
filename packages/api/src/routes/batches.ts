/**
 * Tenant context flows to every engine/store operation; validation failures use the shared HTTP error mapper.
 */
import { Rubric, Subject } from "@verdict-ai/core";
import { Hono } from "hono";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { present } from "../present.js";
import { readIdempotencyKey, tenant } from "./shared.js";

/** Registers batches operations; handler failures propagate to the transport error boundary. */
export function registerBatches(app: Hono<Env>, { engine }: AppOptions) {
  /* ---------- batches (leaderboards) ---------- */
  app.post("/v1/batches", async (c) => {
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const idempotencyKey = readIdempotencyKey(c.req.raw);
    const body = z.object({ rubric: z.union([z.string(), Rubric]), subjects: z.array(Subject).min(1), metadata: z.record(z.string(), z.unknown()).optional(), webhook: z.string().url().optional() }).parse(raw);
    const opts = { tenantId: tenant(c), metadata: body.metadata, webhook: body.webhook };
    // why: preserve the submitted body for conflict detection instead of hashing schema defaults.
    const fingerprintBody = Object.fromEntries(["rubric", "subjects", "metadata", "webhook"].filter(k => k in raw).map(k => [k, raw[k]]));
    const result = idempotencyKey === undefined
      ? { ...await engine.evaluateBatch(body.rubric, body.subjects, opts), replayed: false }
      : await engine.evaluateBatchIdempotent(body.rubric, body.subjects, { ...opts, idempotencyKey, fingerprintBody });
    const { evaluations, ranking, replayed } = result;
    if (replayed) c.header("Idempotency-Replayed", "true");
    return c.json({ ranking, evaluations: evaluations.map((e) => present(e, { ratings: false })) }, replayed ? 200 : 201);
  });

}
