/**
 * Every read respects tenant scope; D1 parameter limits require chunked rating writes.
 */
import { storeOperation } from "./errors.js";
import { DocumentQueries, sqliteQueries, postgresQueries } from "./queries.js";
import { readDocument, evaluationRow, ratingRows } from "./documents.js";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { PUBLICATION_LIST_LIMIT, type ControlStore, type IdempotencyRecord, type Evaluation, type ListOptions, type Publication, type PublicationQuery, type PublicationStore, type Publisher, type PublisherStore, type Store, type StoredRubric } from "@verdict-ai/core";
import { type Schema } from "./schema/sqlite.js";

import { DrizzleControlStore } from "./control.js";
import { pgAtomic, sqliteAtomic, sqliteDialect, pgDialect, type Atomic, type Dialect, type PgDb } from "./dialects.js";

// why: rating projections bind many columns; chunking stays below D1's per-statement parameter budget.
const RATING_INSERT_CHUNK_SIZE = 50;

/** D1, better-sqlite3 and libsql share this SQLite driver contract. */

export type SqliteDb = BaseSQLiteDatabase<"async" | "sync", unknown, Schema>;

/**
 * Store implementation on Drizzle. Documents live in `doc` JSON columns; indexed columns are derived on write so
 * listings and analytics never parse blobs. Tenant scoping is enforced in every read.
 */
export class DrizzleStore implements Store, PublicationStore, PublisherStore {
  private queries: DocumentQueries;
  private reserve: (record: IdempotencyRecord, initial: Evaluation[]) => Promise<void>;
  /** Projects, environments, pointers and reports (docs/design/control-plane.md). */
  readonly control: ControlStore;
  constructor(db: SqliteDb | DocumentQueries, atomicBatch?: (statements: SQL[]) => Promise<void>, dialect: Dialect = sqliteDialect, reserve?: (record: IdempotencyRecord, initial: Evaluation[]) => Promise<void>, atomic?: Atomic) {
    this.queries = db instanceof DocumentQueries ? db : sqliteQueries(db, dialect.tables);
    if (db instanceof DocumentQueries) {
      if (!reserve || !atomic) throw new TypeError("document query adapters require reservation and atomic functions");
      this.reserve = reserve;
      this.control = new DrizzleControlStore(db, atomic);
    } else {
      this.reserve = (record, initial) => dialect.reserve(db, record, initial, atomicBatch);
      this.control = new DrizzleControlStore(this.queries, sqliteAtomic(db, atomicBatch));
    }
  }

  async reserveIdempotency(r: IdempotencyRecord, initial: Evaluation[]): Promise<boolean> {
    return storeOperation(`reserveIdempotency:${r.key}`, async () => {
      const existing = await this.getIdempotency(r.tenantId, r.key);
      if (existing && existing.expiresAt > r.createdAt) {
        const ids = existing.targetType === "batch" ? existing.evaluationIds ?? [] : [existing.targetId!];
        const targets = await Promise.all(ids.map(id => this.getEvaluation(id, r.tenantId)));
        if (targets.every(Boolean)) return false;
      }
      await this.reserve(r, initial);
      const record = await this.getIdempotency(r.tenantId, r.key);
      return record?.targetId === r.targetId && JSON.stringify(record?.evaluationIds) === JSON.stringify(r.evaluationIds);
    });
  }

  async putIdempotency(r: IdempotencyRecord): Promise<void> {
    return storeOperation(`putIdempotency:${r.key}`, async () => {
      const row = {
        tenantId: r.tenantId ?? "", key: r.key, fingerprint: r.fingerprint, targetType: r.targetType,
        targetId: r.targetId ?? null, targetIds: r.evaluationIds ?? null, createdAt: r.createdAt, expiresAt: r.expiresAt
      };
      await this.queries.insert("idempotencyKeys", [row], { keys: ["tenantId", "key"], set: row });
    });
  }

  async getIdempotency(tenantId: string | undefined, key: string): Promise<IdempotencyRecord | undefined> {
    return storeOperation(`getIdempotency:${key}`, async () => {
      const { idempotencyKeys } = this.queries.tables;
      const [row] = await this.queries.select("idempotencyKeys", { where: and(eq(idempotencyKeys.tenantId, tenantId ?? ""), eq(idempotencyKeys.key, key)), limit: 1 });
      return row ? {
        tenantId: row.tenantId || undefined, key: row.key, fingerprint: row.fingerprint, targetType: row.targetType,
        targetId: row.targetId ?? undefined, evaluationIds: row.targetIds ?? undefined, createdAt: row.createdAt, expiresAt: row.expiresAt
      } : undefined;
    });
  }

  /* ---------------- rubrics ---------------- */

  async putRubric(r: StoredRubric): Promise<void> {
    return storeOperation(`putRubric:${r.id}`, async () => {
      const row = { id: r.id, tenantId: r.tenantId ?? null, name: r.name, version: r.version, doc: { ...r }, createdAt: r.createdAt, updatedAt: r.updatedAt };
      await this.queries.insert("rubrics", [row], { keys: ["id"], set: { tenantId: row.tenantId, name: row.name, version: row.version, doc: row.doc, updatedAt: row.updatedAt } });
    });
  }

  async getRubric(id: string, tenantId?: string): Promise<StoredRubric | undefined> {
    return storeOperation(`getRubric:${id}`, async () => {
      const { rubrics } = this.queries.tables;
      const rows = await this.queries.select("rubrics", { where: eq(rubrics.id, id), limit: 1 });
      const row = rows[0];
      if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) return undefined;
      return readDocument<StoredRubric>(row.doc);
    });
  }

  async listRubrics(o: ListOptions = {}): Promise<StoredRubric[]> {
    return storeOperation("listRubrics", async () => {
      const { rubrics } = this.queries.tables;
      const where = o.tenantId === undefined ? undefined : eq(rubrics.tenantId, o.tenantId);
      const rows = await this.queries.select("rubrics", { where, orderBy: desc(rubrics.createdAt), limit: o.limit ?? 100 });
      return rows.map((r) => readDocument<StoredRubric>(r.doc));
    });
  }

  async deleteRubric(id: string, tenantId?: string): Promise<boolean> {
    return storeOperation(`deleteRubric:${id}`, async () => {
      const { rubrics } = this.queries.tables;
      if (!(await this.getRubric(id, tenantId))) return false;
      await this.queries.delete("rubrics", eq(rubrics.id, id));
      return true;
    });
  }

  /* ---------------- evaluations ---------------- */

  async putEvaluation(e: Evaluation): Promise<void> {
    return storeOperation(`putEvaluation:${e.id}`, async () => {
      const { ratings } = this.queries.tables;
      const row = evaluationRow(e);
      const { id: _id, createdAt: _c, ...set } = row;
      await this.queries.insert("evaluations", [row], { keys: ["id"], set });

      // Denormalized ratings: replace the evaluation's rows (ratings change when humans submit).
      await this.queries.delete("ratings", eq(ratings.evaluationId, e.id));
      const rows = ratingRows(e);
      // D1 caps bound parameters per statement; insert in modest chunks.
      for (let i = 0; i < rows.length; i += RATING_INSERT_CHUNK_SIZE) await this.queries.insert("ratings", rows.slice(i, i + RATING_INSERT_CHUNK_SIZE));
    });
  }

  async getEvaluation(id: string, tenantId?: string): Promise<Evaluation | undefined> {
    return storeOperation(`getEvaluation:${id}`, async () => {
      const { evaluations } = this.queries.tables;
      const rows = await this.queries.select("evaluations", { where: eq(evaluations.id, id), limit: 1 });
      const row = rows[0];
      if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) return undefined;
      return readDocument<Evaluation>(row.doc);
    });
  }

  async listEvaluations(o: ListOptions = {}): Promise<Evaluation[]> {
    return storeOperation("listEvaluations", async () => {
      const { evaluations } = this.queries.tables;
      const conds = [
        o.tenantId === undefined ? undefined : eq(evaluations.tenantId, o.tenantId),
        o.rubricId ? eq(evaluations.rubricId, o.rubricId) : undefined,
        o.status ? eq(evaluations.status, o.status) : undefined,
      ].filter((c): c is NonNullable<typeof c> => !!c);
      const rows = await this.queries.select("evaluations", { where: and(...conds), orderBy: desc(evaluations.createdAt), limit: o.limit ?? 100 });
      return rows.map((r) => readDocument<Evaluation>(r.doc));
    });
  }

  /* ---------------- publications (public hub) ---------------- */

  async putPublication(p: Publication): Promise<void> {
    return storeOperation(`putPublication:${p.id}`, async () => {
      const row = {
        id: p.id, tenantId: p.tenantId ?? null, owner: p.owner, slug: p.slug, versionId: p.version.id, title: p.title,
        domain: p.domain ?? null, locale: p.locale ?? null, judgmentType: p.judgmentType, license: p.license,
        doc: { ...p } as Record<string, unknown>, createdAt: p.createdAt, withdrawnAt: p.withdrawnAt ?? null,
      };
      const { id: _id, createdAt: _c, ...set } = row;
      await this.queries.insert("publications", [row], { keys: ["id"], set });
    });
  }

  async getPublication(id: string): Promise<Publication | undefined> {
    return storeOperation(`getPublication:${id}`, async () => {
      const { publications } = this.queries.tables;
      const [row] = await this.queries.select("publications", { where: eq(publications.id, id), limit: 1 });
      return row ? publicationOf(row) : undefined;
    });
  }

  async listPublications(q: PublicationQuery = {}): Promise<Publication[]> {
    return storeOperation("listPublications", async () => {
      const { publications: t } = this.queries.tables;
      const needle = q.q ? `%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
      const conds = [
        q.includeWithdrawn ? undefined : isNull(t.withdrawnAt),
        q.tenantId === undefined ? undefined : eq(t.tenantId, q.tenantId),
        q.domain ? eq(t.domain, q.domain) : undefined, q.locale ? eq(t.locale, q.locale) : undefined,
        q.judgmentType ? eq(t.judgmentType, q.judgmentType) : undefined, q.owner ? eq(t.owner, q.owner) : undefined,
        q.slug ? eq(t.slug, q.slug) : undefined, q.versionId ? eq(t.versionId, q.versionId) : undefined,
        // lower() on both sides: SQLite LIKE ignores ASCII case, Postgres LIKE does not.
        needle ? or(...[t.title, t.owner, t.slug, t.domain].map((col) => sql`lower(${col}) like ${needle} escape '\\'`)) : undefined,
      ].filter((c): c is NonNullable<typeof c> => !!c);
      const rows = await this.queries.select("publications", { where: conds.length ? and(...conds) : undefined, orderBy: desc(t.createdAt), limit: q.limit ?? PUBLICATION_LIST_LIMIT });
      return rows.map(publicationOf);
    });
  }

  async withdrawPublication(id: string, tenantId: string | undefined, at: string): Promise<boolean> {
    return storeOperation(`withdrawPublication:${id}`, async () => {
      const existing = await this.getPublication(id);
      if (!existing || existing.tenantId !== tenantId) return false;
      if (existing.withdrawnAt) return true;
      await this.putPublication({ ...existing, withdrawnAt: at });
      return true;
    });
  }

  /* ---------------- publishers (hub sign-in) ---------------- */

  async putPublisher(p: Publisher): Promise<void> {
    return storeOperation(`putPublisher:${p.tenantId}`, async () => {
      const row = { tenantId: p.tenantId, githubId: p.githubId, login: p.login, createdAt: p.createdAt, updatedAt: p.updatedAt };
      await this.queries.insert("publishers", [row], { keys: ["tenantId"], set: { login: row.login, updatedAt: row.updatedAt } });
    });
  }

  async getPublisher(tenantId: string): Promise<Publisher | undefined> {
    return storeOperation(`getPublisher:${tenantId}`, async () => {
      const [row] = await this.queries.select("publishers", { where: eq(this.queries.tables.publishers.tenantId, tenantId), limit: 1 });
      return row ? { tenantId: row.tenantId, githubId: row.githubId, login: row.login, createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined;
    });
  }

  /* ---------------- analytics helpers ---------------- */

  /** Per-criterion rating rows for a rubric (feeds calibration: confidence vs. human agreement). */
  async ratingsForRubric(rubricId: string, tenantId?: string, judgeTypes?: string[]) {
    return storeOperation(`ratingsForRubric:${rubricId}`, async () => {
      const { ratings } = this.queries.tables;
      const conds = [eq(ratings.rubricId, rubricId), tenantId === undefined ? undefined : eq(ratings.tenantId, tenantId), judgeTypes?.length ? inArray(ratings.judgeType, judgeTypes) : undefined].filter((c): c is NonNullable<typeof c> => !!c);
      return this.queries.select("ratings", { where: and(...conds) });
    });
  }
}

/** Postgres facade over the shared document and rating logic. */
export class PgStore extends DrizzleStore {
  constructor(db: PgDb) {
    super(postgresQueries(db, pgDialect.tables), undefined, undefined, (record, initial) => pgDialect.reserve(db, record, initial), pgAtomic(db));
  }
}

// The withdrawn column is authoritative: a document written before its withdrawal still reads as withdrawn.
function publicationOf(row: { doc: unknown; withdrawnAt: string | null }): Publication {
  const doc = row.doc as Publication;
  return row.withdrawnAt ? { ...doc, withdrawnAt: row.withdrawnAt } : doc;
}
