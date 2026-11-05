CREATE TABLE `request_limits` (
	`bucket_hash` text PRIMARY KEY NOT NULL,
	`reset_at` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `request_limits_reset_idx` ON `request_limits` (`reset_at`);--> statement-breakpoint
ALTER TABLE `billing_connection` ADD `refresh_lock_until` integer DEFAULT 0 NOT NULL;