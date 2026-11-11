/**
 * Public hub reads (docs/design/hub.md §9, §16.3): search, a card's versions and one publication, as JSON under
 * `/v1/public/*` and as pages under `/hub`. No API key. These are the only store reads that are not tenant-scoped, and
 * they read only the publications collection, through `publicView`, which drops the publishing tenant.
 */
import {
  hasPublications, latestPerRef, listingOf, NotFoundError, publicView, versionEntry, withdrawalNote,
  type Publication, type PublicationQuery, type PublicationStore, type PublicPublication, type PublicVersionEntry,
} from "@verdict-ai/core";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { cardPage, goneCardPage, missingPage, searchPage } from "../hub-pages.js";
import { defaultClientKey, enforce } from "../rate-limit.js";

/** Public paths start with these; the tenant middleware lets them through without a key. */
export const isPublicHubPath = (path: string) => path.startsWith("/v1/public/") || path === "/hub" || path.startsWith("/hub/");

const SEARCH_LIMIT = 50;
/** Enough rows to find the newest version of each card a page shows. */
const SCAN_LIMIT = 500;

const Search = z.object({
  q: z.string().max(200).optional(), domain: z.string().max(60).optional(), locale: z.string().max(35).optional(),
  type: z.enum(["score", "noul", "choice"]).optional(), owner: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT).default(SEARCH_LIMIT),
});
export type PublicSearch = z.infer<typeof Search>;

/** A withdrawn version answers 410: it existed and was taken down, which is different from never existing. */
export class WithdrawnError extends Error {
  constructor(public publication: Publication) {
    super(withdrawalNote(publication));
  }
}

export function registerPublicHub(app: Hono<Env>, { engine, limits, clientKey = defaultClientKey }: Pick<AppOptions, "engine" | "limits" | "clientKey">) {
  const store = (): PublicationStore => {
    if (!hasPublications(engine.store)) throw new HTTPException(501, { message: "this server's store cannot keep publications" });
    return engine.store;
  };
  const hub = publicHub(store);
  // One check per request: in Hono "/hub/*" also matches "/hub", so the paths are tested here rather than as patterns.
  app.use(async (c, next) => {
    if (isPublicHubPath(c.req.path)) await enforce(limits?.read, clientKey(c), "hub read");
    await next();
  });

  app.get("/v1/public/rubrics", async (c) => c.json({ data: (await hub.search(Search.parse(c.req.query()))).map(listingOf) }));

  app.get("/v1/public/rubrics/:owner/:slug", async (c) => {
    try { return c.json(await hub.card(c.req.param("owner"), c.req.param("slug"), c.req.query("version"))); }
    catch (e) { return withdrawnJson(c, e); }
  });

  app.get("/v1/public/publications/:id", async (c) => {
    try { return c.json(await hub.publication(c.req.param("id"))); }
    catch (e) { return withdrawnJson(c, e); }
  });

  app.get("/hub", async (c) => {
    const parsed = Search.safeParse(c.req.query());
    const query = parsed.success ? parsed.data : Search.parse({});
    return html(c, searchPage({ query, results: (await hub.search(query)).map(listingOf) }));
  });

  app.get("/hub/:owner/:slug", async (c) => {
    const origin = new URL(c.req.url).origin;
    try { return html(c, cardPage({ origin, ...(await hub.card(c.req.param("owner"), c.req.param("slug"), c.req.query("version"))) })); }
    catch (e) {
      if (e instanceof WithdrawnError) return html(c, goneCardPage(e.publication, e.message), 410);
      if (e instanceof NotFoundError) return html(c, missingPage(e.message), 404);
      throw e;
    }
  });
}

/** The reads themselves, kept apart from HTTP so the JSON routes and the pages answer the same way. */
export function publicHub(store: () => PublicationStore) {
  return {
    async search(q: PublicSearch): Promise<Publication[]> {
      const query: PublicationQuery = { q: q.q || undefined, domain: q.domain || undefined, locale: q.locale || undefined, judgmentType: q.type, owner: q.owner || undefined, limit: SCAN_LIMIT };
      return latestPerRef(await store().listPublications(query)).slice(0, q.limit);
    },

    /** A card at `versionId`, or at its newest live version, with every version it has had. */
    async card(owner: string, slug: string, versionId?: string): Promise<{ publication: PublicPublication; versions: PublicVersionEntry[] }> {
      const all = await store().listPublications({ owner, slug, includeWithdrawn: true, limit: SCAN_LIMIT });
      if (!all.length) throw new NotFoundError(`no card ${owner}/${slug} on this hub`);
      const chosen = versionId ? all.find((p) => p.version.id === versionId) : all.find((p) => !p.withdrawnAt) ?? all[0];
      if (!chosen) throw new NotFoundError(`${owner}/${slug} has no version ${versionId}`);
      if (chosen.withdrawnAt) throw new WithdrawnError(chosen);
      return { publication: publicView(chosen), versions: all.map(versionEntry) };
    },

    async publication(id: string): Promise<PublicPublication> {
      const p = await store().getPublication(id);
      if (!p) throw new NotFoundError(`publication ${id} not found`);
      if (p.withdrawnAt) throw new WithdrawnError(p);
      return publicView(p);
    },
  };
}

function withdrawnJson(c: Context<Env>, e: unknown) {
  if (!(e instanceof WithdrawnError)) throw e;
  return c.json({ error: { type: e.publication.takedown ? "taken_down" : "withdrawn", message: e.message, withdrawnAt: e.publication.withdrawnAt } }, 410);
}

/** Pages carry no scripts and load nothing from elsewhere: everything shown is author-written text, escaped. */
function html(c: Context<Env>, body: string, status: 200 | 404 | 410 = 200) {
  c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  return c.html(body, status);
}
