CREATE TABLE `plex_tokens` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Everybody who signed in with Plex before this table existed keeps syncing once their session
-- ends: the token of their newest live session, copied as stored (same key). The /adminlogin
-- account has no plex.tv token and is left out.
INSERT OR IGNORE INTO `plex_tokens` (`user_id`, `token`, `updated_at`)
SELECT s.`user_id`, s.`server_token`, s.`created_at`
FROM `auth_sessions` s
JOIN `users` u ON u.`id` = s.`user_id`
JOIN `app_config` c ON c.`id` = u.`server_id`
WHERE c.`server_type` = 'plex'
  AND u.`server_user_id` != 'watcharr:recovery'
  AND s.`id` = (
    SELECT s2.`id` FROM `auth_sessions` s2
    WHERE s2.`user_id` = s.`user_id` AND s2.`expires_at` > (unixepoch() * 1000)
    ORDER BY s2.`created_at` DESC, s2.`id` DESC
    LIMIT 1
  );
