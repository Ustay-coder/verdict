import { and, desc, eq, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Evaluation, ListOptions, Store, StoredRubric } from "@verdict/core";
import { evaluations, ratings, rubrics, type Schema } from "./schema/sqlite.js";

/** Any Drizzle SQLite database: D1 (`drizzle-orm/d1`, async), better-sqlite3 (sync), libsql. */
export type SqliteDb = BaseSQLiteDatabase<"async" | "sync", unknown, Schema>;

/**
 * Store implementation on Drizzle. Documents live in `doc` JSON columns; indexed columns are derived on write so
 * listings and analytics never parse blobs. Tenant scoping is enforced in every read.
 */
export class DrizzleStore implements Store {
  constructor(private db: SqliteDb) {}

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
