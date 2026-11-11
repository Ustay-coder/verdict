/**
 * Storage of public hub documents. Unlike every other store read, public reads are not tenant-scoped: they read only
 * this collection, which holds nothing but copies authors chose to make public (docs/design/hub.md K3). Writes and
 * withdrawals are tied to the publishing tenant.
 */
import type { Publication } from "./publication.js";

export interface PublicationQuery {
  /** Case-insensitive substring match on title, owner, slug and domain (the columns every store can search). */
  q?: string;
  domain?: string; locale?: string; judgmentType?: string;
  owner?: string; slug?: string; versionId?: string;
  /** The publisher's own listing may include withdrawn documents; public listings never do. */
  tenantId?: string;
  includeWithdrawn?: boolean;
  limit?: number;
}

export interface PublicationStore {
  putPublication(p: Publication): Promise<void>;
  getPublication(id: string): Promise<Publication | undefined>;
  /** Newest first. */
  listPublications(q?: PublicationQuery): Promise<Publication[]>;
  /** Marks a tenant's publication withdrawn; false when it is not theirs or does not exist. */
  withdrawPublication(id: string, tenantId: string | undefined, at: string): Promise<boolean>;
}

export function hasPublications(store: object): store is PublicationStore {
  return typeof (store as Partial<PublicationStore>).putPublication === "function";
}

/** The in-memory and file stores share this filter so every adapter answers a query the same way. */
export function matchesPublication(p: Publication, q: PublicationQuery): boolean {
  if (p.withdrawnAt && !q.includeWithdrawn) return false;
  if (q.tenantId !== undefined && p.tenantId !== q.tenantId) return false;
  const equal: Array<[string | undefined, string | undefined]> = [[q.domain, p.domain], [q.locale, p.locale], [q.judgmentType, p.judgmentType], [q.owner, p.owner], [q.slug, p.slug], [q.versionId, p.version.id]];
  if (equal.some(([want, have]) => want !== undefined && want !== have)) return false;
  if (!q.q) return true;
  const needle = q.q.toLowerCase();
  return [p.title, p.owner, p.slug, p.domain].some((field) => field?.toLowerCase().includes(needle));
}

export const PUBLICATION_LIST_LIMIT = 50;

/**
 * Who publishes under a tenant: the GitHub account that signed in (docs/design/hub.md H2). The tenant is keyed by the
 * numeric GitHub id, which survives a renamed login; `login` is refreshed on every sign-in and is the public handle.
 */
export interface Publisher { tenantId: string; githubId: number; login: string; createdAt: string; updatedAt: string }

export interface PublisherStore {
  putPublisher(p: Publisher): Promise<void>;
  getPublisher(tenantId: string): Promise<Publisher | undefined>;
}

export function hasPublishers(store: object): store is PublisherStore {
  return typeof (store as Partial<PublisherStore>).putPublisher === "function";
}

