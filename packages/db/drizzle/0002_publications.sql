CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`owner` text NOT NULL,
	`slug` text NOT NULL,
	`version_id` text NOT NULL,
	`title` text NOT NULL,
	`domain` text,
	`locale` text,
	`judgment_type` text NOT NULL,
	`license` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	`withdrawn_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publications_owner_slug_version` ON `publications` (`owner`,`slug`,`version_id`);--> statement-breakpoint
CREATE INDEX `publications_created` ON `publications` (`created_at`);--> statement-breakpoint
CREATE INDEX `publications_version` ON `publications` (`version_id`);--> statement-breakpoint
CREATE INDEX `publications_tenant` ON `publications` (`tenant_id`);