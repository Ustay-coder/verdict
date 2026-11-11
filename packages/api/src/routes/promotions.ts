/**
 * Pointer changes and their history (docs/design/control-plane.md §5). A promotion names the version the caller saw;
 * the store applies all of a request's changes or none, and a stale request is answered with where the pointers are.
 */
import {
  CONTROL_LIST_LIMIT, NotFoundError, planRollback, PromotionRequest, promotionEvents, RollbackRequest,
  type ControlStore, type ProjectScope, type PromotionContext, type PromotionEvent, type PromotionRefusal,
} from "@verdict-ai/core";
import { Hono } from "hono";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { ApiError, bare, controlContext, readJson } from "./shared.js";

const HistoryQuery = z.object({
  environment: z.string().optional(), name: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(CONTROL_LIST_LIMIT).default(CONTROL_LIST_LIMIT),
});

const noEnvironment = (ctx: PromotionContext) => new NotFoundError(`environment ${ctx.environment} not found in project ${ctx.scope.project}`);

/** Where the named pointers are now, for the answer to a request that saw them elsewhere. */
async function current(store: ControlStore, scope: ProjectScope, environment: string, names: string[]) {
  const pointers = await store.listPointers(scope, environment);
  return names.map((name) => ({ name, versionId: pointers.find((p) => p.name === name)?.versionId ?? null }));
}

/** The error for a batch the store refused. */
async function refusal(store: ControlStore, reason: PromotionRefusal, events: PromotionEvent[], ctx: PromotionContext): Promise<Error> {
  if (reason === "no_environment") return noEnvironment(ctx);
  if (reason === "unknown_version") {
    for (const e of events) {
      if (e.to !== null && !(await store.getVersion(ctx.scope, e.name, e.to))) return new ApiError(400, "unknown_version", `version ${e.to} is not kept under ${e.name} in project ${ctx.scope.project}; upload it first`);
    }
  }
  const now = await current(store, ctx.scope, ctx.environment, events.map((e) => e.name));
  return new ApiError(409, "pointer_conflict", `${ctx.environment} changed since you read it; nothing was applied`, { current: now });
}

/** Registers promotion, rollback and history routes. */
export function registerPromotions(app: Hono<Env>, options: AppOptions) {
  const { store, scope, allow, project, at } = controlContext(options);
  const base = "/v1/projects/:project/environments/:environment";

  app.post(`${base}/promotions`, async (c) => {
    const request = PromotionRequest.parse(await readJson(c.req.raw));
    const ctx: PromotionContext = { scope: scope(c), environment: c.req.param("environment"), actor: c.get("actor"), at: at() };
    for (const change of request.changes) {
      await allow(c, change.versionId === null ? "pointer.unset" : "pointer.promote", { project: ctx.scope.project, environment: ctx.environment, name: change.name, versionId: change.versionId });
    }
    const events = promotionEvents(request, ctx);
    const result = await store().applyPromotions(events);
    if (!result.ok) throw await refusal(store(), result.reason, events, ctx);
    return c.json({ events: events.map(bare) });
  });

  app.post(`${base}/rollbacks`, async (c) => {
    const request = RollbackRequest.parse(await readJson(c.req.raw));
    const ctx: PromotionContext = { scope: scope(c), environment: c.req.param("environment"), actor: c.get("actor"), at: at() };
    await allow(c, "pointer.rollback", { project: ctx.scope.project, environment: ctx.environment, name: request.name });
    const plan = await planRollback(store(), request, ctx);
    if (!plan.ok) {
      if (plan.reason === "no_environment") throw noEnvironment(ctx);
      if (plan.reason === "nothing_to_roll_back") throw new ApiError(409, "nothing_to_roll_back", `${request.name} in ${ctx.environment} has no earlier version on record`);
      throw new ApiError(409, "pointer_conflict", `${ctx.environment} changed since you read it; nothing was applied`, { current: [{ name: request.name, versionId: plan.current }] });
    }
    const result = await store().applyPromotions([plan.event]);
    if (!result.ok && result.reason === "unknown_version") throw new ApiError(409, "nothing_to_roll_back", `the earlier version ${plan.event.to} of ${request.name} was deleted`);
    if (!result.ok) throw await refusal(store(), result.reason, [plan.event], ctx);
    return c.json({ event: bare(plan.event) });
  });

  app.get("/v1/projects/:project/history", async (c) => {
    const q = HistoryQuery.parse(c.req.query());
    await allow(c, "history.read", { project: c.req.param("project"), environment: q.environment, name: q.name });
    return c.json({ data: (await store().listHistory(await project(c), q)).map(bare) });
  });
}
