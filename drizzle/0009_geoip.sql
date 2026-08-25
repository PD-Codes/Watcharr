ALTER TABLE `app_settings` ADD `geoip_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `geoip_url` text;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `remote_address` text;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `is_local` integer;