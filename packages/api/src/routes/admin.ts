/**
 * Defines admin request handling at the REST boundary.
 * Tenant context flows to every engine/store operation; validation failures use the shared HTTP error mapper.
 */
import { hasPublications, NotFoundError, ValidationError, type Engine, type Publication, type PublicationStore } from "@verdict-ai/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppOptions, Env, KeyManager } from "../app.js";

/** Registers admin operations; handler failures propagate to the transport error boundary. */
export function registerAdmin(app: Hono<Env>, { engine, keys, adminKey, now = () => Date.now() }: AppOptions) {
  app.use("/v1/admin/*", async (c, next) => {
    if (!adminKey) throw new HTTPException(404, { message: "admin API disabled (set VERDICT_ADMIN_KEY)" });
    const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (header !== adminKey) throw new HTTPException(401, { message: "invalid admin key" });
    await next();
  });
  registerAdminKeys(app, keys);
  registerTakedowns(app, engine, now);
}

/* ---------- admin: API keys ---------- */
function registerAdminKeys(app: Hono<Env>, keys: KeyManager | undefined) {
  const manager = (): KeyManager => {
    if (!keys) throw new HTTPException(404, { message: "key management needs a database-backed key store" });
    return keys;
  };
  app.post("/v1/admin/keys", async (c) => {
    const body = z.object({ tenantId: z.string().min(1), name: z.string().min(1) }).parse(await c.req.json());
    return c.json(await manager().createKey(body.tenantId, body.name), 201);
  });
  app.get("/v1/admin/keys", async (c) => {
    const tenantId = c.req.query("tenant");
    if (!tenantId) throw new ValidationError("query param `tenant` is required");
    return c.json({ data: await manager().listKeys(tenantId) });
  });
  app.delete("/v1/admin/keys/:id", async (c) => {
    if (!(await manager().revokeKey(c.req.param("id")))) throw new NotFoundError(`key ${c.req.param("id")} not found`);
    return c.body(null, 204);
  });
}

/*
 * ---------- admin: hub takedowns (docs/design/hub.md H6) ----------
 * Operators can take any publication down, with a reason that is shown publicly, and put back only what they took down:
 * an author's own withdrawal is the author's to keep.
 */
function registerTakedowns(app: Hono<Env>, engine: Engine, now: () => number) {
  const store = (): PublicationStore => {
    if (!hasPublications(engine.store)) throw new HTTPException(404, { message: "this server's store cannot keep publications" });
    return engine.store;
  };
  const find = async (id: string): Promise<Publication> => {
    const p = await store().getPublication(id);
    if (!p) throw new NotFoundError(`publication ${id} not found`);
    return p;
  };

  app.get("/v1/admin/publications", async (c) => {
    const q = z.object({ q: z.string().optional(), owner: z.string().optional(), slug: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(c.req.query());
    return c.json({ data: await store().listPublications({ ...q, includeWithdrawn: true }) });
  });

  app.post("/v1/admin/publications/:id/takedown", async (c) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(await c.req.json());
    const p = await find(c.req.param("id")), at = new Date(now()).toISOString();
    const next: Publication = { ...p, withdrawnAt: p.withdrawnAt ?? at, takedown: { reason, at } };
    await store().putPublication(next);
    return c.json({ publication: next });
  });

  app.post("/v1/admin/publications/:id/restore", async (c) => {
    const p = await find(c.req.param("id"));
    if (!p.takedown) throw new HTTPException(409, { message: `${p.ref} at ${p.version.id} was not taken down${p.withdrawnAt ? "; its author withdrew it" : ""}` });
    const { takedown: _takedown, withdrawnAt: _withdrawnAt, ...restored } = p;
    await store().putPublication(restored);
    return c.json({ publication: restored });
  });
}
