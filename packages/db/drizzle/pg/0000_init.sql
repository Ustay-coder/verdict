CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"rubric_id" text,
	"rubric_name" text NOT NULL,
	"subject_name" text,
	"status" text NOT NULL,
	"score" double precision,
	"grade" text,
	"passed" boolean,
	"pending_human" integer DEFAULT 0 NOT NULL,
	"decision_calls" integer DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"tenant_id" text,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_ids" jsonb,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"tenant_id" text,
	"rubric_id" text,
	"criterion_id" text NOT NULL,
	"rater_id" text NOT NULL,
	"judge_type" text NOT NULL,
	"status" text NOT NULL,
	"score" double precision,
	"normalized" double precision,
	"confidence" double precision,
	"model" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rubrics" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_tenant" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "evaluations_tenant_created" ON "evaluations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "evaluations_rubric_created" ON "evaluations" USING btree ("rubric_id","created_at");--> statement-breakpoint
CREATE INDEX "evaluations_tenant_status" ON "evaluations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_tenant_key" ON "idempotency_keys" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "ratings_evaluation" ON "ratings" USING btree ("evaluation_id");--> statement-breakpoint
CREATE INDEX "ratings_rubric_criterion" ON "ratings" USING btree ("rubric_id","criterion_id");--> statement-breakpoint
CREATE INDEX "ratings_tenant_judge" ON "ratings" USING btree ("tenant_id","judge_type");--> statement-breakpoint
CREATE INDEX "rubrics_tenant_created" ON "rubrics" USING btree ("tenant_id","created_at");