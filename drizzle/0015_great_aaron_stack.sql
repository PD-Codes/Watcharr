ALTER TABLE `users` ADD `notify_email` text;--> statement-breakpoint
ALTER TABLE `users` ADD `notify_events` text DEFAULT '[]' NOT NULL;