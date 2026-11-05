CREATE TABLE `billing_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`encrypted_session` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_enrollment` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`key_mask` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_enrollment_api_key_id_unique` ON `billing_enrollment` (`api_key_id`);