CREATE INDEX `playback_sessions_started_idx` ON `playback_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `playback_sessions_user_started_idx` ON `playback_sessions` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `watch_history_watched_idx` ON `watch_history` (`watched_at`);