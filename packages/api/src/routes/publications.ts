/**
 * Publishing to the public hub (docs/design/hub.md §16). Authenticated: a tenant previews, publishes and withdraws its
 * own publications. Preview and publish build the document with the same function, so what the author previews is
 * what is stored. Public reads come later (P3-3) and read only the publications collection.
 */
import { buildPublication, hasPublications, NotFoundError, PUBLICATION_LIMITS, withdrawalNote, type Publication, type PublicationStore } from "@verdict-ai/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppOptions, Env } from "../app.js";
import { enforce } from "../rate-limit.js";
import { tenant } from "./shared.js";

/** Registers publication routes; requests are validated by `buildPublication`, never trusted as documents. */
export function registerPublications(app: Hono<Env>, { engine, publisherOf = defaultPublisher, now = () => Date.now(), limits }: AppOptions) {
  const store = (): PublicationStore => {
    if (!hasPublications(engine.store)) throw new HTTPException(501, { message: "this server's store cannot keep publications" });
    return engine.store;
  };

  const build = async (raw: Request, tenantId: string | undefined) => {
    // Previews do the same work as publishing, so they count against the same per-account limit.
    await enforce(limits?.publish, tenantId ?? "local", "publishing");
    const text = await raw.text();
    if (new TextEncoder().encode(text).length > PUBLICATION_LIMITS.bytes) throw new HTTPException(413, { message: `a publication request may be at most ${PUBLICATION_LIMITS.bytes} bytes` });
    const owner = await publisherOf(tenantId);
    if (!owner) throw new HTTPException(403, { message: "publishing needs a GitHub sign-in: run `verdict hub login`" });
    const s = store();
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new HTTPException(400, { message: "the publication request must be JSON" }); }
    return buildPublication(body, {
      owner, tenantId,
      findParent: async (versionId) => {
        const [parent] = await s.listPublications({ versionId, limit: 1 });
        return parent ? { id: parent.id, ref: parent.ref } : undefined;
      },
    });
  };

  // A diagnostic, like /v1/rubrics/validate: a rejected request is a successful answer listing its issues.
  app.post("/v1/publications/preview", async (c) => c.json(await build(c.req.raw, tenant(c))));

  app.post("/v1/publications", async (c) => {
    const tenantId = tenant(c);
    const result = await build(c.req.raw, tenantId);
    if (!result.ok || !result.publication) return c.json({ error: { type: "validation", message: "the publication was rejected", issues: result.issues } }, 400);
    const s = store(), draft = result.publication;
    // A renamed GitHub login can be taken by someone else: a ref stays with the account that first published under it.
    const [first] = await s.listPublications({ owner: draft.owner, slug: draft.slug, includeWithdrawn: true, limit: 1 });
    if (first && first.tenantId !== tenantId) throw new HTTPException(409, { message: `${draft.ref} belongs to another account; choose another slug` });
    const [existing] = await s.listPublications({ owner: draft.owner, slug: draft.slug, versionId: draft.version.id, includeWithdrawn: true, limit: 1 });
    if (existing?.withdrawnAt) throw new HTTPException(409, { message: `${withdrawalNote(existing)}; publish a new version instead` });
    // Publishing the same version again is a no-op that returns the stored document.
    if (existing) return c.json({ publication: existing, warnings: result.warnings, created: false }, 200);
    const publication: Publication = { id: `pub_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, ...draft, createdAt: new Date(now()).toISOString() };
    await s.putPublication(publication);
    return c.json({ publication, warnings: result.warnings, created: true }, 201);
  });

  app.get("/v1/publications", async (c) => {
    // An open single-tenant server has no tenant: every publication on it is the caller's.
    return c.json({ data: await store().listPublications({ tenantId: tenant(c), includeWithdrawn: true, limit: Number(c.req.query("limit") ?? 50) }) });
  });

  app.delete("/v1/publications/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await store().withdrawPublication(id, tenant(c), new Date(now()).toISOString()))) throw new NotFoundError(`publication ${id} not found`);
    return c.body(null, 204);
  });
}

/** Until authors sign in with GitHub (P3-2), a tenant publishes under its own id; open single-tenant mode under "local". */
function defaultPublisher(tenantId: string | undefined): string {
  return tenantId ?? "local";
}
