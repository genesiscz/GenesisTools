import { index, integer, pgTable, text } from "drizzle-orm/pg-core";

export const todos = pgTable(
    "todos",
    {
        id: text().primaryKey().notNull(),
        text: text().notNull(),
        completed: integer().default(0).notNull(),
        userId: text("user_id").notNull(),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
    },
    (table) => [index("idx_todos_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops"))]
);

export const timers = pgTable(
    "timers",
    {
        id: text().primaryKey().notNull(),
        name: text().notNull(),
        timerType: text("timer_type").notNull(),
        isRunning: integer("is_running").default(0).notNull(),
        elapsedTime: integer("elapsed_time").default(0).notNull(),
        duration: integer(),
        laps: text().default("[]"),
        userId: text("user_id").notNull(),
        createdAt: text("created_at").notNull(),
        updatedAt: text("updated_at").notNull(),
        showTotal: integer("show_total").default(0).notNull(),
        firstStartTime: text("first_start_time"),
        startTime: text("start_time"),
        pomodoroSettings: text("pomodoro_settings"),
        pomodoroPhase: text("pomodoro_phase"),
        pomodoroSessionCount: integer("pomodoro_session_count").default(0),
    },
    (table) => [index("idx_timers_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops"))]
);

export const activityLogs = pgTable(
    "activity_logs",
    {
        id: text().primaryKey().notNull(),
        timerId: text("timer_id").notNull(),
        timerName: text("timer_name").notNull(),
        userId: text("user_id").notNull(),
        eventType: text("event_type").notNull(),
        timestamp: text().notNull(),
        elapsedAtEvent: integer("elapsed_at_event").default(0).notNull(),
        sessionDuration: integer("session_duration"),
        previousValue: integer("previous_value"),
        newValue: integer("new_value"),
        metadata: text().default("{}"),
    },
    (table) => [
        index("idx_activity_logs_timer_id").using("btree", table.timerId.asc().nullsLast().op("text_ops")),
        index("idx_activity_logs_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
    ]
);
