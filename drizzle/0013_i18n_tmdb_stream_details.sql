CREATE TABLE `tmdb_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `default_locale` text DEFAULT 'en-US' NOT NULL;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `audio_channels` integer;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `subtitle_codec` text;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `source_video_codec` text;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `source_audio_codec` text;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `source_container` text;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `source_height` integer;--> statement-breakpoint
ALTER TABLE `playback_sessions` ADD `source_bitrate_kbps` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `locale` text;