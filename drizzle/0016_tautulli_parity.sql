ALTER TABLE `app_settings` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `api_key` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `retention_session_days` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `retention_log_days` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `retention_history_days` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `retention_last_at` integer;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `conditions` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `template` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `watch_history` ADD `source` text DEFAULT 'server' NOT NULL;