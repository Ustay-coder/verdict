CREATE TABLE `comparison_reports` (
	`tenant_id` text NOT NULL,
	`project` text NOT NULL,
	`id` text NOT NULL,
	`rubric_name` text NOT NULL,
	`head_version_id` text NOT NULL,
	`doc` text NOT NULL,
	`reported_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `project`, `id`)
);
--> statement-breakpoint
CREATE INDEX `comparison_reports_reported` ON `comparison_reports` (`tenant_id`,`project`,`reported_at`);--> statement-breakpoint
CREATE TABLE `environments` (
	`tenant_id` text NOT NULL,
	`project` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `project`, `name`)
);
--> statement-breakpoint
CREATE TABLE `pointers` (
	`tenant_id` text NOT NULL,
	`project` text NOT NULL,
	`environment` text NOT NULL,
	`rubric_name` text NOT NULL,
	`version_id` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `project`, `environment`, `rubric_name`)
);
--> statement-breakpoint
CREATE INDEX `pointers_version` ON `pointers` (`tenant_id`,`project`,`rubric_name`,`version_id`);--> statement-breakpoint
CREATE TABLE `project_versions` (
	`tenant_id` text NOT NULL,
	`project` text NOT NULL,
	`rubric_name` text NOT NULL,
	`version_id` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `project`, `rubric_name`, `version_id`)
);
--> statement-breakpoint
CREATE INDEX `project_versions_created` ON `project_versions` (`tenant_id`,`project`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE `promotions` (
	`tenant_id` text NOT NULL,
	`project` text NOT NULL,
	`id` text NOT NULL,
	`environment` text NOT NULL,
	`rubric_name` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `project`, `id`)
);
--> statement-breakpoint
CREATE INDEX `promotions_created` ON `promotions` (`tenant_id`,`project`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_reports` (
	`tenant_id` text NOT NULL,
	`project` text NOT NULL,
	`run_id` text NOT NULL,
	`rubric_name` text NOT NULL,
	`version_id` text NOT NULL,
	`dataset_name` text,
	`started_at` text NOT NULL,
	`doc` text NOT NULL,
	`reported_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `project`, `run_id`)
);
--> statement-breakpoint
CREATE INDEX `run_reports_started` ON `run_reports` (`tenant_id`,`project`,`started_at`);