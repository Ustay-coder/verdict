import { sql, type SQL } from "drizzle-orm";
import type { IdempotencyRecord, Evaluation } from "@verdict/core";
import { schema } from "./schema/sqlite.js";
import { schema as pgSchema } from "./schema/pg.js";
import type { SqliteDb } from "./store.js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** The common query-builder surface is identical; dialect casts stay at this boundary. */
export interface Dialect {
  tables: typeof schema;
  reserve(db: SqliteDb, r: IdempotencyRecord, initial: Evaluation[], atomicBatch?: (statements: SQL[]) => Promise<void>): Promise<void>;
}
export const sqliteDialect: Dialect = {
  tables: schema,
  async reserve(db, r, initial, atomicBatch) {
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
    if (atomicBatch) await atomicBatch(statements);
    else db.transaction(tx => { for (const statement of statements) tx.run(statement); }, { behavior: "immediate" });

  },
};
export type PgDb = PgDatabase<PgQueryResultHKT, typeof pgSchema>;
export const pgDialect: Dialect = {
  tables: pgSchema as unknown as typeof schema,
  async reserve(db, r, initial) {
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
          (select 1 from jsonb_array_elements_text(idempotency_keys.target_ids) as target(value) where not exists
            (select 1 from evaluations where id = target.value and coalesce(tenant_id, '') = ${tenant})))`];
    const owner = r.targetId ?? r.evaluationIds?.[0];
    for (const e of initial) {
      statements.push(sql`insert into evaluations (id, tenant_id, rubric_id, rubric_name, subject_name, status, doc, created_at, updated_at)
        select ${e.id}, ${e.tenantId ?? null}, ${e.rubricId ?? null}, ${e.rubric.name}, ${e.subject.name ?? null}, ${e.status}, ${JSON.stringify(e)}, ${e.createdAt}, ${e.updatedAt}
        where exists (select 1 from idempotency_keys where tenant_id=${tenant} and key=${r.key}
          and coalesce(target_id, target_ids->>0)=${owner ?? null})`);
    }
    await (db as unknown as PgDb).transaction(async tx => {
      // Get a fresh READ COMMITTED snapshot after competing reservations commit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenant, r.key])}, 0))`);
      for (const statement of statements) await tx.execute(statement);
    });

  },
};
