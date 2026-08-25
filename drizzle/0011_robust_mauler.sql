CREATE TABLE `monitor_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule` text NOT NULL,
	`message` text NOT NULL,
	`value` integer,
	`threshold` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `monitor_alerts_created_idx` ON `monitor_alerts` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_type` text NOT NULL,
	`channel_id` integer,
	`channel_name` text DEFAULT '' NOT NULL,
	`event` text NOT NULL,
	`success` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_log_created_idx` ON `notification_log` (`created_at`);--> statement-breakpoint
ALTER TABLE `app_settings` ADD `monitor_failed_login_threshold` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `monitor_failed_login_window_min` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `digest_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `digest_frequency` text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `digest_last_sent_at` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_auto_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_interval_hours` integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_retention` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `backup_last_at` integer;