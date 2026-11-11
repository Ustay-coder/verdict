CREATE TABLE "publishers" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"github_id" integer NOT NULL,
	"login" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "publishers_github_id" ON "publishers" USING btree ("github_id");