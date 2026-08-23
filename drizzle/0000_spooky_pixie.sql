CREATE TABLE `activity_sessions` (
	`session_key` text PRIMARY KEY NOT NULL,
	`user_id` integer,
	`item_id` text NOT NULL,
	`title` text NOT NULL,
	`media_type` text NOT NULL,
	`state` text NOT NULL,
	`progress_ms` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`is_transcoding` integer DEFAULT false NOT NULL,
	`bandwidth_kbps` integer,
	`device_name` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_sessions_user_idx` ON `activity_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `app_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`server_type` text NOT NULL,
	`server_url` text NOT NULL,
	`server_token` text NOT NULL,
	`server_name` text,
	`tmdb_api_key` text,
	`features` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`server_token` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `suggestions_cache` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`generated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_user_id` text NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`avatar_url` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_server_user_idx` ON `users` (`server_user_id`);--> statement-breakpoint
CREATE TABLE `watch_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_id` text NOT NULL,
	`title` text NOT NULL,
	`grandparent_title` text,
	`media_type` text NOT NULL,
	`year` integer,
	`genres` text DEFAULT '[]' NOT NULL,
	`watched_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`device_name` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `watch_history_user_watched_idx` ON `watch_history` (`user_id`,`watched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `watch_history_dedupe_idx` ON `watch_history` (`user_id`,`item_id`,`watched_at`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`item_id` text NOT NULL,
	`title` text NOT NULL,
	`media_type` text NOT NULL,
	`year` integer,
	`poster_url` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`source` text DEFAULT 'local' NOT NULL,
	`added_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_user_item_idx` ON `watchlist` (`user_id`,`item_id`);