-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "todos" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timer_type" text NOT NULL,
	"is_running" integer DEFAULT 0 NOT NULL,
	"elapsed_time" integer DEFAULT 0 NOT NULL,
	"duration" integer,
	"laps" text DEFAULT '[]',
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"show_total" integer DEFAULT 0 NOT NULL,
	"first_start_time" text,
	"start_time" text,
	"pomodoro_settings" text,
	"pomodoro_phase" text,
	"pomodoro_session_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timer_id" text NOT NULL,
	"timer_name" text NOT NULL,
	"user_id" text NOT NULL,
	"event_type" text NOT NULL,
	"timestamp" text NOT NULL,
	"elapsed_at_event" integer DEFAULT 0 NOT NULL,
	"session_duration" integer,
	"previous_value" integer,
	"new_value" integer,
	"metadata" text DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX "idx_todos_user_id" ON "todos" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_timers_user_id" ON "timers" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_logs_timer_id" ON "activity_logs" USING btree ("timer_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_activity_logs_user_id" ON "activity_logs" USING btree ("user_id" text_ops);
*/