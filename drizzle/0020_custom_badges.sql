CREATE TABLE `custom_badges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text NOT NULL,
	`metric` text NOT NULL,
	`filter` text DEFAULT 'none' NOT NULL,
	`filter_value` text DEFAULT '' NOT NULL,
	`tiers` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
