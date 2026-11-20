DROP INDEX `playback_sessions_user_idx`;--> statement-breakpoint
ALTER TABLE `users` ADD `theme` text;--> statement-breakpoint
CREATE INDEX `login_history_user_ip_idx` ON `login_history` (`user_id`,`ip`,`created_at`);