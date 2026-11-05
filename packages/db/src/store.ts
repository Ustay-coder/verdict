import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { IdempotencyRecord, Evaluation, ListOptions, Store, StoredRubric } from "@verdict/core";
import { idempotencyKeys, evaluations, ratings, rubrics, type Schema } from "./schema/sqlite.js";

/** Any Drizzle SQLite database: D1 (`drizzle-orm/d1`, async), better-sqlite3 (sync), libsql. */
export type SqliteDb = BaseSQLiteDatabase<"async" | "sync", unknown, Schema>;

/**
 * Store implementation on Drizzle. Documents live in `doc` JSON columns; indexed columns are derived on write so
 * listings and analytics never parse blobs. Tenant scoping is enforced in every read.
 */
export class DrizzleStore implements Store {
  constructor(private db: SqliteDb, private atomicBatch?: (statements: SQL[]) => Promise<void>) {}

  async reserveIdempotency(r: IdempotencyRecord, initial: Evaluation[]): Promise<boolean> {
    const tenant = r.tenantId ?? "";
    // The reservation and initial documents commit together. Concurrent connections see
    // either no reservation or a reservation whose targets already exist.
    const statements: SQL[] = [sql`insert into idempotency_keys
      (tenant_id, key, fingerprint, target_type, target_id, target_ids, created_at, expires_at)
      values (${tenant}, ${r.key}, ${r.fingerprint}, ${r.targetType}, ${r.targetId ?? null}, ${r.evaluationIds ? JSON.stringify(r.evaluationIds) : null}, ${r.createdAt}, ${r.expiresAt})
      on conflict (tenant_id, key) do update set fingerprint=excluded.fingerprint, target_type=excluded.target_type,
        target_id=excluded.target_id, target_ids=excluded.target_ids, created_at=excluded.created_at, expires_at=excluded.expires_at
      where idempotency_keys.expires_at <= ${new Date().toISOString()}
        or (idempotency_keys.target_type = 'evaluation' and not exists
          (select 1 from evaluations where id = idempotency_keys.target_id and coalesce(tenant_id, '') = ${tenant}))
        or (idempotency_keys.target_type = 'batch' and exists
          (select 1 from json_each(idempotency_keys.target_ids) as target where not exists
            (select 1 from evaluations where id = target.value and coalesce(tenant_id, '') = ${tenant})))`];
    const owner = r.targetId ?? r.evaluationIds?.[0];
    for (const e of initial) {
      statements.push(sql`insert into evaluations (id, tenant_id, rubric_id, rubric_name, subject_name, status, doc, created_at, updated_at)
        select ${e.id}, ${e.tenantId ?? null}, ${e.rubricId ?? null}, ${e.rubric.name}, ${e.subject.name ?? null}, ${e.status}, ${JSON.stringify(e)}, ${e.createdAt}, ${e.updatedAt}
        where exists (select 1 from idempotency_keys where tenant_id=${tenant} and key=${r.key}
          and coalesce(target_id, json_extract(target_ids, '$[0]'))=${owner ?? null})`);
    }
    if (this.atomicBatch) await this.atomicBatch(statements);
    else this.db.transaction(tx => { for (const statement of statements) tx.run(statement); }, { behavior: "immediate" });
    const record = await this.getIdempotency(r.tenantId, r.key);
    return record?.targetId === r.targetId && JSON.stringify(record?.evaluationIds) === JSON.stringify(r.evaluationIds);
  }

  async putIdempotency(r: IdempotencyRecord): Promise<void> {
    const row = { tenantId: r.tenantId ?? "", key: r.key, fingerprint: r.fingerprint, targetType: r.targetType,
      targetId: r.targetId ?? null, targetIds: r.evaluationIds ?? null, createdAt: r.createdAt, expiresAt: r.expiresAt };
    await this.db.insert(idempotencyKeys).values(row).onConflictDoUpdate({ target: [idempotencyKeys.tenantId, idempotencyKeys.key], set: row });
  }

  async getIdempotency(tenantId: string | undefined, key: string): Promise<IdempotencyRecord | undefined> {
    const [row] = await this.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, tenantId ?? ""), eq(idempotencyKeys.key, key))).limit(1);
    return row ? { tenantId: row.tenantId || undefined, key: row.key, fingerprint: row.fingerprint, targetType: row.targetType,
      targetId: row.targetId ?? undefined, evaluationIds: row.targetIds ?? undefined, createdAt: row.createdAt, expiresAt: row.expiresAt } : undefined;
  }

  /* ---------------- rubrics ---------------- */

  async putRubric(r: StoredRubric): Promise<void> {
    const row = { id: r.id, tenantId: r.tenantId ?? null, name: r.name, version: r.version, doc: r as unknown as Record<string, unknown>, createdAt: r.createdAt, updatedAt: r.updatedAt };
    await this.db.insert(rubrics).values(row).onConflictDoUpdate({ target: rubrics.id, set: { tenantId: row.tenantId, name: row.name, version: row.version, doc: row.doc, updatedAt: row.updatedAt } });
  }

  async getRubric(id: string, tenantId?: string): Promise<StoredRubric | undefined> {
    const rows = await this.db.select({ doc: rubrics.doc, tenantId: rubrics.tenantId }).from(rubrics).where(eq(rubrics.id, id)).limit(1);
    const row = rows[0];
    if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) return undefined;
    return row.doc as unknown as StoredRubric;
  }

  async listRubrics(o: ListOptions = {}): Promise<StoredRubric[]> {
    const where = o.tenantId === undefined ? undefined : eq(rubrics.tenantId, o.tenantId);
    const rows = await this.db.select({ doc: rubrics.doc }).from(rubrics).where(where).orderBy(desc(rubrics.createdAt)).limit(o.limit ?? 100);
    return rows.map((r) => r.doc as unknown as StoredRubric);
  }

  async deleteRubric(id: string, tenantId?: string): Promise<boolean> {
    if (!(await this.getRubric(id, tenantId))) return false;
    await this.db.delete(rubrics).where(eq(rubrics.id, id));
    return true;
  }

  /* ---------------- evaluations ---------------- */

  async putEvaluation(e: Evaluation): Promise<void> {
    const row = {
      id: e.id,
      tenantId: e.tenantId ?? null,
      rubricId: e.rubricId ?? null,
      rubricName: e.rubric.name,
      subjectName: e.subject.name ?? null,
      status: e.status,
      score: e.aggregate.score ?? null,
      grade: e.aggregate.grade ?? null,
      passed: e.aggregate.passed ?? null,
      pendingHuman: e.pendingTasks.length,
      decisionCalls: e.usage.decisionCalls,
      llmCalls: e.usage.llmCalls,
      inputTokens: e.usage.inputTokens,
      durationMs: e.usage.durationMs,
      doc: e as unknown as Record<string, unknown>,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
    const { id: _id, createdAt: _c, ...set } = row;
    await this.db.insert(evaluations).values(row).onConflictDoUpdate({ target: evaluations.id, set });

    // Denormalized ratings: replace the evaluation's rows (ratings change when humans submit).
    await this.db.delete(ratings).where(eq(ratings.evaluationId, e.id));
    const rows = e.criteria.flatMap((c) =>
      c.ratings.map((r) => ({
        id: r.id,
        evaluationId: e.id,
        tenantId: e.tenantId ?? null,
        rubricId: e.rubricId ?? null,
        criterionId: c.criterionId,
        raterId: r.raterId,
        judgeType: r.judgeType,
        status: r.status,
        score: r.score ?? null,
        normalized: r.normalized ?? null,
        confidence: r.confidence ?? null,
        model: (r.raw?.model as string | undefined) ?? null,
        createdAt: r.createdAt,
      })),
    );
    // D1 caps bound parameters per statement; insert in modest chunks.
    for (let i = 0; i < rows.length; i += 50) await this.db.insert(ratings).values(rows.slice(i, i + 50));
  }

  async getEvaluation(id: string, tenantId?: string): Promise<Evaluation | undefined> {
    const rows = await this.db.select({ doc: evaluations.doc, tenantId: evaluations.tenantId }).from(evaluations).where(eq(evaluations.id, id)).limit(1);
    const row = rows[0];
    if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) return undefined;
    return row.doc as unknown as Evaluation;
  }

  async listEvaluations(o: ListOptions = {}): Promise<Evaluation[]> {
    const conds = [
      o.tenantId === undefined ? undefined : eq(evaluations.tenantId, o.tenantId),
      o.rubricId ? eq(evaluations.rubricId, o.rubricId) : undefined,
      o.status ? eq(evaluations.status, o.status) : undefined,
    ].filter((c): c is NonNullable<typeof c> => !!c);
    const rows = await this.db.select({ doc: evaluations.doc }).from(evaluations).where(conds.length ? and(...conds) : undefined).orderBy(desc(evaluations.createdAt)).limit(o.limit ?? 100);
    return rows.map((r) => r.doc as unknown as Evaluation);
  }

  /* ---------------- analytics helpers ---------------- */

  /** Per-criterion rating rows for a rubric (feeds calibration: confidence vs. human agreement). */
  async ratingsForRubric(rubricId: string, tenantId?: string, judgeTypes?: string[]) {
    const conds = [eq(ratings.rubricId, rubricId), tenantId === undefined ? undefined : eq(ratings.tenantId, tenantId), judgeTypes?.length ? inArray(ratings.judgeType, judgeTypes) : undefined].filter((c): c is NonNullable<typeof c> => !!c);
    return this.db.select().from(ratings).where(and(...conds));
  }
}
