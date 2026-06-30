CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`day` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_expenses_user_day` ON `expenses` (`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_expenses_category` ON `expenses` (`category`);--> statement-breakpoint
CREATE TABLE `goal_key_results` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`title` text NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`start_value` integer DEFAULT 0 NOT NULL,
	`target_value` integer DEFAULT 100 NOT NULL,
	`current_value` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_goal_key_results_goal_id` ON `goal_key_results` (`goal_id`);--> statement-breakpoint
CREATE INDEX `idx_goal_key_results_user_id` ON `goal_key_results` (`user_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'personal' NOT NULL,
	`quarter` text DEFAULT '' NOT NULL,
	`target_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_goals_user_id` ON `goals` (`user_id`);--> statement-breakpoint
CREATE TABLE `habit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`habit_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_habit_entries_habit_day` ON `habit_entries` (`habit_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_habit_entries_user_id` ON `habit_entries` (`user_id`);--> statement-breakpoint
CREATE TABLE `habits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'emerald' NOT NULL,
	`icon` text DEFAULT 'CircleCheck' NOT NULL,
	`cadence` text DEFAULT 'daily' NOT NULL,
	`target_per_week` integer DEFAULT 7 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_habits_user_id` ON `habits` (`user_id`);--> statement-breakpoint
CREATE TABLE `mood_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`mood` integer NOT NULL,
	`energy` integer DEFAULT 3 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mood_entries_user_day` ON `mood_entries` (`user_id`,`day`);--> statement-breakpoint
CREATE TABLE `reading_highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`text` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reading_highlights_item_id` ON `reading_highlights` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_reading_highlights_user_id` ON `reading_highlights` (`user_id`);--> statement-breakpoint
CREATE TABLE `reading_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'book' NOT NULL,
	`url` text,
	`cover_url` text,
	`status` text DEFAULT 'to_read' NOT NULL,
	`current_page` integer DEFAULT 0 NOT NULL,
	`total_pages` integer DEFAULT 0 NOT NULL,
	`rating` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reading_items_user_id` ON `reading_items` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_reading_items_status` ON `reading_items` (`status`);