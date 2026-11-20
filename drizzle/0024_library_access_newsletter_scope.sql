CREATE TABLE `user_library_access` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`section_ids` text NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_last_libraries` text;