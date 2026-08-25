ALTER TABLE `app_settings` ADD `webhook_url` text;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `webhook_events` text DEFAULT '[]' NOT NULL;