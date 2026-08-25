CREATE TABLE `geoip_cache` (
	`ip` text PRIMARY KEY NOT NULL,
	`country` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer,
	`user_id` integer,
	`username` text NOT NULL,
	`success` integer NOT NULL,
	`ip` text,
	`country` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `login_history_created_idx` ON `login_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`config` text DEFAULT '' NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `monitor_max_streams_per_user` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `monitor_bandwidth_mbps` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `monitor_transcode_alert` integer DEFAULT false NOT NULL;