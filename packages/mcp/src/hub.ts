/**
 * Hub tools for agents (docs/design/hub.md P3-4): search published cards, read one, and fork one into the rubrics this
 * server keeps so `evaluate` can use it. Public reads only — no hub key is sent. A card is used only after its rubric
 * freezes here to the version the hub names.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { forkDraft, parseHubRef, questionAgreement, ValidationError, verifyPublishedVersion, type Engine, type PublicPublication } from "@verdict-ai/core";
import { Verdict } from "@verdict-ai/sdk";
import { z } from "zod";

import { text, toolResult } from "./result.js";

export interface HubToolOptions {
  /** Default hub (VERDICT_HUB_URL); each call may name another. */
  hubUrl?: string;
  fetch?: typeof fetch;
  engine?: Engine;
  client?: Verdict;
}

const CASES_SHOWN = 20;

export function registerHub(server: McpServer, opts: HubToolOptions) {
  const hubFor = (hub?: string) => {
    const url = (hub ?? opts.hubUrl)?.replace(/\/$/, "");
    if (!url) throw new ValidationError("no hub configured: pass `hub` or set VERDICT_HUB_URL");
    // An empty key: never fall back to VERDICT_API_KEY, which belongs to another server.
    return { url, client: new Verdict({ baseUrl: url, apiKey: "", fetch: opts.fetch }) };
  };
  const load = async (ref: string, hub?: string) => {
    const r = parseHubRef(ref), h = hubFor(hub);
    const { publication, versions } = await h.client.hub.card(r.owner, r.slug, r.versionId ? { version: r.versionId } : {});
    return { hub: h.url, publication, versions, version: await verifyPublishedVersion(publication, r.versionId, h.url) };
  };

  server.registerTool("hub_search", {
    title: "Search the hub",
    description: "Search published single-question judgment cards (rubrics with public test cases). Returns one result per card at its newest version, with a `hub:owner/slug@rv_…` ref for hub_get or fork_rubric.",
    inputSchema: {
      q: z.string().optional().describe("matches title, author, slug and domain"), domain: z.string().optional(), locale: z.string().optional(),
      type: z.enum(["score", "noul", "choice"]).optional().describe("noul = yes/no"), owner: z.string().optional(), limit: z.number().int().min(1).max(50).optional(),
      hub: z.string().url().optional(),
    },
  }, async ({ hub, ...q }) => toolResult(async () => {
    const { data } = await hubFor(hub).client.hub.search(q);
    return text(data.map((d) => ({ ref: `hub:${d.ref}@${d.latest.versionId}`, title: d.title, description: d.description, judgmentType: d.judgmentType, domain: d.domain, locale: d.locale, license: d.license, cases: d.cases, runs: d.runs })));
  }));

  server.registerTool("hub_get", {
    title: "Read a hub card",
    description: "Read a published card: its question and answers, threshold, licence, lineage, author-reported agreement numbers, versions and some public cases. `ref` is hub:owner/slug or hub:owner/slug@rv_….",
    inputSchema: { ref: z.string(), hub: z.string().url().optional() },
  }, async ({ ref, hub }) => toolResult(async () => {
    const card = await load(ref, hub);
    return text({ ref: `hub:${card.publication.ref}@${card.version.id}`, hub: card.hub, ...describe(card.publication), versions: card.versions, rubric: card.version.rubric });
  }));

  server.registerTool("fork_rubric", {
    title: "Fork a hub card",
    description: "Copy a published card into this server's rubrics (a new rubric id; the card is not changed) so `evaluate` can use it. The rubric's metadata records where it came from and its licence.",
    inputSchema: { ref: z.string(), hub: z.string().url().optional(), name: z.string().optional().describe("name for the copy (default: the card's)") },
  }, async ({ ref, hub, name }) => toolResult(async () => {
    const card = await load(ref, hub);
    const forkedFrom = { hub: card.hub, ref: `hub:${card.publication.ref}@${card.version.id}`, versionId: card.version.id, license: card.publication.license };
    const draft = forkDraft(card.version);
    const rubric = { ...draft, ...(name ? { name } : {}), metadata: { ...draft.metadata, forkedFrom } };
    const stored = opts.client ? await opts.client.rubrics.create(rubric) : await opts.engine!.createRubric(rubric);
    return text({ id: stored.id, name: stored.name, forkedFrom, publicCases: card.publication.cases.length });
  }));
}

function describe(p: PublicPublication) {
  const c = p.version.rubric.criteria[0]!;
  return {
    title: p.title, description: p.description, license: p.license, judgmentType: p.judgmentType, domain: p.domain, locale: p.locale,
    question: { id: c.id, name: c.name, description: c.description, anchors: c.anchors, choices: c.choices, levels: c.levels, threshold: c.threshold },
    parent: p.parent, changeKinds: p.version.changeKinds, forkNote: p.version.forkNote, sources: p.sources,
    runs: p.runs.map((r) => ({ origin: r.origin, cases: r.counts.cases, agreement: questionAgreement(p, r), casesPublic: r.casesPublic, labelSources: r.labelSources, models: r.fingerprint.models })),
    cases: { total: p.cases.length, shown: p.cases.slice(0, CASES_SHOWN) },
  };
}
