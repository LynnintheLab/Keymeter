CREATE TABLE `seller_password` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`password_hash` text NOT NULL,
	`version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seller_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_hash` text NOT NULL,
	`password_version` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seller_sessions_expiry_idx` ON `seller_sessions` (`expires_at`);