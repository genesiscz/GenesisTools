CREATE TABLE `activity_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timer_id` text NOT NULL,
	`timer_name` text NOT NULL,
	`user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`timestamp` text NOT NULL,
	`elapsed_at_event` integer DEFAULT 0 NOT NULL,
	`session_duration` integer,
	`previous_value` integer,
	`new_value` integer,
	`metadata` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX `idx_activity_logs_user_id` ON `activity_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_activity_logs_timer_id` ON `activity_logs` (`timer_id`);--> statement-breakpoint
CREATE TABLE `assistant_badges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`badge_type` text NOT NULL,
	`earned_at` text NOT NULL,
	`display_name` text NOT NULL,
	`rarity` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_badges_user_id` ON `assistant_badges` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_blockers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`reason` text NOT NULL,
	`blocked_since` text NOT NULL,
	`blocker_owner` text,
	`follow_up_action` text,
	`reminder_set` text,
	`unblocked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_blockers_user_id` ON `assistant_blockers` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_blockers_task_id` ON `assistant_blockers` (`task_id`);--> statement-breakpoint
CREATE TABLE `assistant_celebrations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tier` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_id` text,
	`shown_at` text,
	`dismissed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_celebrations_user_id` ON `assistant_celebrations` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_communications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source_url` text,
	`discussed_at` text NOT NULL,
	`tags` text DEFAULT '[]',
	`related_task_ids` text DEFAULT '[]',
	`sentiment` text DEFAULT 'context' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_communications_user_id` ON `assistant_communications` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`completion_type` text NOT NULL,
	`completed_at` text NOT NULL,
	`celebration_shown` integer DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_completions_user_id` ON `assistant_completions` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_context_parking` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`content` text NOT NULL,
	`code_context` text,
	`discovery_notes` text,
	`next_steps` text,
	`status` text DEFAULT 'active' NOT NULL,
	`parked_at` text NOT NULL,
	`resumed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_context_parking_user_id` ON `assistant_context_parking` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_context_parking_task_id` ON `assistant_context_parking` (`task_id`);--> statement-breakpoint
CREATE TABLE `assistant_deadline_risks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`risk_level` text NOT NULL,
	`projected_completion_date` text NOT NULL,
	`days_late` integer DEFAULT 0 NOT NULL,
	`days_remaining` integer DEFAULT 0 NOT NULL,
	`percent_complete` integer DEFAULT 0 NOT NULL,
	`recommended_option` text NOT NULL,
	`calculated_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_deadline_risks_user_id` ON `assistant_deadline_risks` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_deadline_risks_task_id` ON `assistant_deadline_risks` (`task_id`);--> statement-breakpoint
CREATE TABLE `assistant_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`reasoning` text NOT NULL,
	`alternatives_considered` text DEFAULT '[]',
	`decided_at` text NOT NULL,
	`decided_by` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`superseded_by` text,
	`reversal_reason` text,
	`impact_area` text NOT NULL,
	`related_task_ids` text DEFAULT '[]',
	`tags` text DEFAULT '[]',
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_decisions_user_id` ON `assistant_decisions` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_distractions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`source` text NOT NULL,
	`description` text,
	`duration` integer,
	`task_interrupted` text,
	`resumed_task` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_distractions_user_id` ON `assistant_distractions` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_energy_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`timestamp` text NOT NULL,
	`focus_quality` integer NOT NULL,
	`context_switches` integer DEFAULT 0 NOT NULL,
	`tasks_completed` integer DEFAULT 0 NOT NULL,
	`type_of_work` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_energy_snapshots_user_id` ON `assistant_energy_snapshots` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`handed_off_from` text NOT NULL,
	`handed_off_to` text NOT NULL,
	`handoff_at` text NOT NULL,
	`summary` text NOT NULL,
	`context_notes` text NOT NULL,
	`decisions` text DEFAULT '[]',
	`blockers` text DEFAULT '[]',
	`next_steps` text DEFAULT '[]',
	`gotchas` text,
	`contact` text NOT NULL,
	`reviewed` integer DEFAULT 0 NOT NULL,
	`reviewed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_handoffs_user_id` ON `assistant_handoffs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_handoffs_task_id` ON `assistant_handoffs` (`task_id`);--> statement-breakpoint
CREATE TABLE `assistant_streaks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`current_streak_days` integer DEFAULT 0 NOT NULL,
	`longest_streak_days` integer DEFAULT 0 NOT NULL,
	`last_task_completion_date` text NOT NULL,
	`streak_reset_date` text
);
--> statement-breakpoint
CREATE TABLE `assistant_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`project_id` text,
	`deadline` text,
	`urgency_level` text DEFAULT 'nice-to-have' NOT NULL,
	`is_shipping_blocker` integer DEFAULT 0 NOT NULL,
	`context_parking_lot` text,
	`linked_github` text,
	`blocked_by` text DEFAULT '[]',
	`blocks` text DEFAULT '[]',
	`status` text DEFAULT 'backlog' NOT NULL,
	`completed_at` text,
	`focus_time_logged` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_tasks_user_id` ON `assistant_tasks` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_weekly_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`week_end` text NOT NULL,
	`tasks_completed` integer DEFAULT 0 NOT NULL,
	`tasks_completed_last_week` integer DEFAULT 0 NOT NULL,
	`deadlines_hit` integer DEFAULT 0 NOT NULL,
	`deadlines_total` integer DEFAULT 0 NOT NULL,
	`total_minutes` integer DEFAULT 0 NOT NULL,
	`deep_focus_minutes` integer DEFAULT 0 NOT NULL,
	`meeting_minutes` integer DEFAULT 0 NOT NULL,
	`average_energy` integer DEFAULT 0 NOT NULL,
	`energy_by_day` text DEFAULT '{}',
	`peak_focus_time` text,
	`low_energy_time` text,
	`insights` text DEFAULT '[]',
	`recommendations` text DEFAULT '[]',
	`badges_earned` text DEFAULT '[]',
	`streak_days` integer DEFAULT 0 NOT NULL,
	`generated_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_weekly_reviews_user_id` ON `assistant_weekly_reviews` (`user_id`);--> statement-breakpoint
CREATE TABLE `timers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timer_type` text NOT NULL,
	`is_running` integer DEFAULT 0 NOT NULL,
	`elapsed_time` integer DEFAULT 0 NOT NULL,
	`duration` integer,
	`laps` text DEFAULT '[]',
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`show_total` integer DEFAULT 0 NOT NULL,
	`first_start_time` text,
	`start_time` text,
	`pomodoro_settings` text,
	`pomodoro_phase` text,
	`pomodoro_session_count` integer DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX `idx_timers_user_id` ON `timers` (`user_id`);