CREATE TABLE `idempotency_keys` (
	`tenant_id` text,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_ids` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_tenant_key` ON `idempotency_keys` (`tenant_id`,`key`);