CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`tmdb_api_key` text,
	`features` text DEFAULT '{}' NOT NULL,
	`update_checked_at` integer,
	`update_latest_version` text
);
--> statement-breakpoint
INSERT INTO `app_settings` (`id`, `tmdb_api_key`, `features`, `update_checked_at`, `update_latest_version`)
SELECT 1, `tmdb_api_key`, coalesce(`features`, '{}'), `update_checked_at`, `update_latest_version`
FROM `app_config` WHERE `id` = 1;--> statement-breakpoint
DROP INDEX IF EXISTS `users_server_user_idx`;--> statement-breakpoint
ALTER TABLE `users` ADD `server_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `global_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `users` SET `global_admin` = 1
WHERE `id` = (SELECT `id` FROM `users` WHERE `is_admin` = 1 ORDER BY `id` LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX `users_server_user_idx` ON `users` (`server_id`,`server_user_id`);--> statement-breakpoint
UPDATE `playback_sessions` SET `session_key` = '1:' || `session_key`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_app_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_type` text NOT NULL,
	`server_url` text NOT NULL,
	`server_token` text NOT NULL,
	`server_name` text,
	`label` text DEFAULT '' NOT NULL,
	`slug` text DEFAULT '' NOT NULL,
	`tmdb_api_key` text,
	`features` text,
	`update_checked_at` integer,
	`update_latest_version` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_app_config`("id", "server_type", "server_url", "server_token", "server_name", "label", "slug", "tmdb_api_key", "features", "update_checked_at", "update_latest_version", "created_at") SELECT "id", "server_type", "server_url", "server_token", "server_name", coalesce(nullif("server_name", ''), 'Media Server'), 'server-' || "id", "tmdb_api_key", "features", "update_checked_at", "update_latest_version", "created_at" FROM `app_config`;--> statement-breakpoint
DROP TABLE `app_config`;--> statement-breakpoint
ALTER TABLE `__new_app_config` RENAME TO `app_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `app_config_slug_idx` ON `app_config` (`slug`);
