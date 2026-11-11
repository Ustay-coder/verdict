/**
 * Targets and reservations commit together; Postgres advisory locks require a fresh committed snapshot.
 */
import { storeOperation } from "./errors.js";
import { sql, type SQL } from "drizzle-orm";
import type { IdempotencyRecord, Evaluation } from "@verdict-ai/core";
import { schema } from "./schema/sqlite.js";
import { schema as pgSchema } from "./schema/pg.js";
import type { SqliteDb } from "./store.js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Each reservation accepts only its own driver and schema. */
export interface Dialect<Db = SqliteDb, Tables = typeof schema> {
  tables: Tables;
  reserve(db: Db, r: IdempotencyRecord, initial: Evaluation[], atomicBatch?: (statements: SQL[]) => Promise<void>): Promise<void>;
}
export const sqliteDialect: Dialect = {
  tables: schema,
  async reserve(db, r, initial, atomicBatch) {
    const statements = reservationStatements(r, initial, {
      expand: sql`json_each(idempotency_keys.target_ids) as target`,
      first: sql`json_extract(target_ids, '$[0]')`,
    });
    // why: D1 batches are atomic; local SQLite needs an immediate transaction to serialize writers.
    await storeOperation("reserveIdempotency.sqlite", async () => {
      if (atomicBatch) await atomicBatch(statements);
      else db.transaction(tx => { for (const statement of statements) tx.run(statement); }, { behavior: "immediate" });
    });

  },
};
export type PgDb = PgDatabase<PgQueryResultHKT, typeof pgSchema>;

/**
 * Runs statements as one unit. Writers that pass the same `lockKey` never interleave: SQLite and D1 have one writer
 * anyway, Postgres takes an advisory lock so each statement's guard sees what the previous holder committed.
 */
export type Atomic = (statements: SQL[], lockKey: string) => Promise<void>;

export function sqliteAtomic(db: SqliteDb, atomicBatch?: (statements: SQL[]) => Promise<void>): Atomic {
  return (statements) => storeOperation("atomic.sqlite", async () => {
    // why: D1 batches are atomic; local SQLite needs an immediate transaction to serialize writers.
    if (atomicBatch) await atomicBatch(statements);
    else db.transaction(tx => { for (const statement of statements) tx.run(statement); }, { behavior: "immediate" });
  });
}

export function pgAtomic(db: PgDb): Atomic {
  return (statements, lockKey) => storeOperation("atomic.postgres", () => db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    for (const statement of statements) await tx.execute(statement);
  }));
}
export const pgDialect: Dialect<PgDb, typeof pgSchema> = {
  tables: pgSchema,
  async reserve(db, r, initial) {
    const tenant = r.tenantId ?? "";
    const statements = reservationStatements(r, initial, {
      expand: sql`jsonb_array_elements_text(idempotency_keys.target_ids) as target(value)`,
      first: sql`target_ids->>0`,
    });
    await storeOperation("reserveIdempotency.postgres", () => db.transaction(async tx => {
      // Get a fresh READ COMMITTED snapshot after competing reservations commit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenant, r.key])}, 0))`);
      for (const statement of statements) await tx.execute(statement);
    }));

  },
};

function reservationStatements(r: IdempotencyRecord, initial: Evaluation[], fragments: { expand: SQL; first: SQL }): SQL[] {
  const tenant = r.tenantId ?? "";
  // Expiry uses the attempt timestamp so every adapter shares the engine clock.
  // The reservation and initial documents commit together. Concurrent connections see
  // either no reservation or a reservation whose targets already exist.
  const statements: SQL[] = [sql`insert into idempotency_keys
      (tenant_id, key, fingerprint, target_type, target_id, target_ids, created_at, expires_at)
      values (${tenant}, ${r.key}, ${r.fingerprint}, ${r.targetType}, ${r.targetId ?? null}, ${r.evaluationIds ? JSON.stringify(r.evaluationIds) : null}, ${r.createdAt}, ${r.expiresAt})
      on conflict (tenant_id, key) do update set fingerprint=excluded.fingerprint, target_type=excluded.target_type,
        target_id=excluded.target_id, target_ids=excluded.target_ids, created_at=excluded.created_at, expires_at=excluded.expires_at
      where idempotency_keys.expires_at <= ${r.createdAt}
        or (idempotency_keys.target_type = 'evaluation' and not exists
          (select 1 from evaluations where id = idempotency_keys.target_id and coalesce(tenant_id, '') = ${tenant}))
        or (idempotency_keys.target_type = 'batch' and exists
          (select 1 from ${fragments.expand} where not exists
            (select 1 from evaluations where id = target.value and coalesce(tenant_id, '') = ${tenant})))`];
  const owner = r.targetId ?? r.evaluationIds?.[0];
  for (const e of initial) {
    statements.push(sql`insert into evaluations (id, tenant_id, rubric_id, rubric_name, subject_name, status, doc, created_at, updated_at)
        select ${e.id}, ${e.tenantId ?? null}, ${e.rubricId ?? null}, ${e.rubric.name}, ${e.subject.name ?? null}, ${e.status}, ${JSON.stringify(e)}, ${e.createdAt}, ${e.updatedAt}
        where exists (select 1 from idempotency_keys where tenant_id=${tenant} and key=${r.key}
          and coalesce(target_id, ${fragments.first})=${owner ?? null})`);
  }
  return statements;
}
