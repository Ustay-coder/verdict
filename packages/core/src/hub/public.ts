/**
 * What anyone can read from the hub (docs/design/hub.md §9, §16.3). Public reads go through these functions only: they
 * read the publications collection and drop the one field that is not public (the publishing tenant).
 */
import { ValidationError } from "../engine/errors.js";
import { freezeRubric, type RubricVersion } from "../versions/rubric-version.js";
import type { Publication, PublicRunSummary } from "./publication.js";

/** A publication as the public sees it: everything but the tenant that published it. */
export type PublicPublication = Omit<Publication, "tenantId">;

export function publicView(p: Publication): PublicPublication {
  const { tenantId: _tenantId, ...rest } = p;
  return rest;
}

/** One search result: a published card (`owner/slug`) at its newest live version. */
export interface PublicListing {
  ref: string; owner: string; slug: string;
  title: string; description?: string; domain?: string; locale?: string;
  judgmentType: Publication["judgmentType"]; license: string;
  latest: { publicationId: string; versionId: string; createdAt: string };
  cases: number; runs: number;
  parent?: Publication["parent"];
}

/** One version in a card's history, newest first. */
export interface PublicVersionEntry { publicationId: string; versionId: string; createdAt: string; changeKinds?: string[]; withdrawnAt?: string }

/** Keeps the newest publication of each ref, in the order given (stores list newest first). */
export function latestPerRef(publications: Publication[]): Publication[] {
  const seen = new Set<string>();
  return publications.filter((p) => !seen.has(p.ref) && !!seen.add(p.ref));
}

export function listingOf(p: Publication): PublicListing {
  return {
    ref: p.ref, owner: p.owner, slug: p.slug, title: p.title,
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.domain !== undefined ? { domain: p.domain } : {}),
    ...(p.locale !== undefined ? { locale: p.locale } : {}),
    judgmentType: p.judgmentType, license: p.license,
    latest: { publicationId: p.id, versionId: p.version.id, createdAt: p.createdAt },
    cases: p.cases.length, runs: p.runs.length,
    ...(p.parent ? { parent: p.parent } : {}),
  };
}

export function versionEntry(p: Publication): PublicVersionEntry {
  return {
    publicationId: p.id, versionId: p.version.id, createdAt: p.createdAt,
    ...(p.version.changeKinds ? { changeKinds: p.version.changeKinds } : {}),
    ...(p.withdrawnAt ? { withdrawnAt: p.withdrawnAt } : {}),
  };
}

/** `hub:owner/slug` or `hub:owner/slug@rv_…`, as printed on a hub page. */
export interface HubRef { owner: string; slug: string; versionId?: string }

const HUB_REF = /^hub:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([a-z0-9][a-z0-9-]{0,62})(?:@(rv_[0-9a-f]{20}))?$/;

export const isHubRef = (ref: string) => ref.startsWith("hub:");

export function parseHubRef(ref: string): HubRef {
  const m = HUB_REF.exec(ref.trim());
  if (!m) throw new ValidationError(`${ref} is not a hub reference: expected hub:owner/slug or hub:owner/slug@rv_…`);
  return { owner: m[1]!, slug: m[2]!, ...(m[3] ? { versionId: m[3] } : {}) };
}

export const formatHubRef = (r: HubRef) => `hub:${r.owner}/${r.slug}${r.versionId ? `@${r.versionId}` : ""}`;

/**
 * The version a hub sent, frozen here. A hub is not trusted to name what it sent: the rubric must freeze to the id the
 * reader asked for (or, without one, to the id the hub claims).
 */
export async function verifyPublishedVersion(p: Pick<PublicPublication, "version">, wanted?: string, hub = "the hub"): Promise<RubricVersion> {
  const version = await freezeRubric(p.version.rubric);
  const expected = wanted ?? p.version.id;
  if (version.id !== expected) throw new ValidationError(`${hub} sent a rubric that freezes to ${version.id}, not ${expected}; nothing was written`);
  return version;
}

/** Why a publication is no longer public, in one sentence. */
export function withdrawalNote(p: Pick<Publication, "ref" | "version" | "withdrawnAt" | "takedown">): string {
  const where = `${p.ref} at ${p.version.id}`;
  if (p.takedown) return `${where} was taken down by the hub's operators on ${p.takedown.at.slice(0, 10)}: ${p.takedown.reason}`;
  return `${where} was withdrawn on ${(p.withdrawnAt ?? "").slice(0, 10)}; copies people already pulled or forked remain theirs`;
}

/**
 * How often a run agreed with the labels on the card's one question. Cards are labelled per question (`expected`), so
 * the run's overall pass/fail agreement is usually 0 of 0; the question's tally is the number to show.
 */
export function questionAgreement(p: Pick<Publication, "version">, run: Pick<PublicRunSummary, "agreement">): { n: number; agreed: number; askedHuman: number } {
  const id = p.version.rubric.criteria[0]?.id;
  const tally = id ? run.agreement.criteria[id] : undefined;
  return tally ?? { n: run.agreement.decided, agreed: run.agreement.agreed, askedHuman: 0 };
}
