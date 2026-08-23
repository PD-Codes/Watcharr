CREATE TABLE `playback_sessions` (
	`session_key` text PRIMARY KEY NOT NULL,
	`user_id` integer,
	`item_id` text NOT NULL,
	`title` text NOT NULL,
	`grandparent_title` text,
	`media_type` text NOT NULL,
	`state` text NOT NULL,
	`progress_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`client_name` text,
	`device_name` text,
	`play_method` text,
	`video_codec` text,
	`audio_codec` text,
	`container` text,
	`width` integer,
	`height` integer,
	`bitrate_kbps` integer,
	`transcode_reason` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `playback_sessions_user_idx` ON `playback_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `playback_sessions_last_seen_idx` ON `playback_sessions` (`last_seen_at`);--> statement-breakpoint
DROP TABLE `activity_sessions`;