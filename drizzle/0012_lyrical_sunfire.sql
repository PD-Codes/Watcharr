CREATE TABLE `newsletter_subscriptions` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_day_of_week` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_hour` integer DEFAULT 11 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_libraries` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_subject` text DEFAULT 'Recently added' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_intro` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_unique_id` text DEFAULT 'newsletter' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_last_sent_at` integer;--> statement-breakpoint
ALTER TABLE `app_settings` ADD `newsletter_last_html` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `continent` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `region` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `city` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `postal_code` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `latitude` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `longitude` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `isp` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `organisation` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `asn` text;--> statement-breakpoint
ALTER TABLE `geoip_cache` ADD `host` text;