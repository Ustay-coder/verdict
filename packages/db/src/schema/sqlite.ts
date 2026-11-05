/**
 * Drizzle schema — SQLite dialect (Cloudflare D1 and local files; mirrored for Postgres in `pg.ts`).
 *
 * Design: documents (rubric / evaluation) are stored as JSON blobs — their shapes are owned by the zod schemas in
 * @verdict/core and evolve quickly. Columns exist only for what we query or report on: tenant, status, score, timestamps,
 * and a denormalized `ratings` table for calibration / inter-rater analytics.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rubrics = sqliteTable(
  "rubrics",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    version: text("version").notNull().default("1"),
    /** Full StoredRubric JSON (zod-validated by core). */
    doc: text("doc", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("rubrics_tenant_created").on(t.tenantId, t.createdAt)],
);

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    rubricId: text("rubric_id"),
    rubricName: text("rubric_name").notNull(),
    subjectName: text("subject_name"),
    status: text("status").notNull(), // queued | running | pending_human | completed | failed
    score: real("score"),
    grade: text("grade"),
    passed: integer("passed", { mode: "boolean" }),
    pendingHuman: integer("pending_human").notNull().default(0),
    decisionCalls: integer("decision_calls").notNull().default(0),
    llmCalls: integer("llm_calls").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    /** Full Evaluation JSON (frozen rubric, evidence, criteria, ratings). */
    doc: text("doc", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("evaluations_tenant_created").on(t.tenantId, t.createdAt),
    index("evaluations_rubric_created").on(t.rubricId, t.createdAt),
    index("evaluations_tenant_status").on(t.tenantId, t.status),
  ],
);

/** One row per rating — lets you ask "how do Jev's confidences track human agreement for rubric X" with plain SQL. */
export const ratings = sqliteTable(
  "ratings",
  {
    id: text("id").primaryKey(),
    evaluationId: text("evaluation_id").notNull(),
    tenantId: text("tenant_id"),
    rubricId: text("rubric_id"),
    criterionId: text("criterion_id").notNull(),
    raterId: text("rater_id").notNull(),
    judgeType: text("judge_type").notNull(), // decision | llm | human | benchmark | panel
    status: text("status").notNull(), // scored | pending | error
    score: real("score"),
    normalized: real("normalized"),
    confidence: real("confidence"),
    model: text("model"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("ratings_evaluation").on(t.evaluationId),
    index("ratings_rubric_criterion").on(t.rubricId, t.criterionId),
    index("ratings_tenant_judge").on(t.tenantId, t.judgeType),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    /** sha256(hex) of the plaintext key; the plaintext is shown once at creation. */
    keyHash: text("key_hash").notNull(),
    /** First 8 chars of the key, for display (`vk_live_ab12…`). */
    prefix: text("prefix").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.keyHash), index("api_keys_tenant").on(t.tenantId)],
);

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  tenantId: text("tenant_id"),
  key: text("key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  targetType: text("target_type").notNull().$type<"evaluation" | "batch">(),
  targetId: text("target_id"),
  targetIds: text("target_ids", { mode: "json" }).$type<string[]>(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, t => [uniqueIndex("idempotency_keys_tenant_key").on(t.tenantId, t.key)]);

export const schema = { rubrics, evaluations, ratings, apiKeys, idempotencyKeys };
export type Schema = typeof schema;
