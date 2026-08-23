-- SQLite refuses ADD COLUMN with a non-constant DEFAULT as soon as the table holds a
-- row, because it would have to materialise a value per row. The original form of this
-- migration only ever ran against empty tables; on a database with recorded sessions it
-- failed with "Cannot add a column with non-constant default".
--
-- The column therefore arrives with a constant default and is backfilled immediately.
-- last_seen_at is the closest available record of when this session's progress was last
-- observed; sessions that predate that column fall back to now.
ALTER TABLE `playback_sessions` ADD `progress_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `playback_sessions` SET `progress_at` = coalesce(`last_seen_at`, unixepoch() * 1000) WHERE `progress_at` = 0;
