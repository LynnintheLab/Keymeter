CREATE TABLE `quota_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_hash` text NOT NULL,
	`checked_at` text NOT NULL,
	`used_micros` integer NOT NULL,
	`remaining_micros` integer
);
--> statement-breakpoint
CREATE INDEX `quota_checks_key_time_idx` ON `quota_checks` (`key_hash`,`checked_at`,`id`);