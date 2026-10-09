DROP INDEX `watch_history_user_watched_idx`;--> statement-breakpoint
CREATE INDEX `watch_history_user_watched_idx` ON `watch_history` (`user_id`,`watched_at`,`duration_ms`,`media_type`);