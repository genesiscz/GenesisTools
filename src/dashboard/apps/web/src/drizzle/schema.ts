import { pgTable, text, integer, index, jsonb } from 'drizzle-orm/pg-core'

/**
 * Timers table - tracks user timers
 */
export const timers = pgTable('timers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timerType: text('timer_type').notNull().$type<'stopwatch' | 'countdown' | 'pomodoro'>(),

  // State (PostgreSQL uses integer for booleans like SQLite)
  isRunning: integer('is_running').notNull().default(0), // 0 = false, 1 = true
  elapsedTime: integer('elapsed_time').notNull().default(0), // milliseconds
  duration: integer('duration'), // milliseconds (for countdown/pomodoro)

  // JSON fields - use jsonb for better PostgreSQL performance
  // LapEntry from @dashboard/shared
  laps: jsonb('laps').$type<Array<{
    number: number       // Lap number (1-based)
    lapTime: number      // Time for this individual lap in ms
    splitTime: number    // Total elapsed time at this lap in ms
    timestamp: string    // ISO date string when lap was recorded
  }>>().default([]),

  // User ownership
  userId: text('user_id').notNull(),

  // Timestamps
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),

  // Enhanced functionality
  showTotal: integer('show_total').notNull().default(0), // 0 = false, 1 = true
  firstStartTime: text('first_start_time'), // ISO timestamp
  startTime: text('start_time'), // ISO timestamp

  // Pomodoro-specific fields
  pomodoroSettings: jsonb('pomodoro_settings').$type<{
    workDuration: number
    shortBreakDuration: number
    longBreakDuration: number
    sessionsBeforeLongBreak: number
  }>(),
  pomodoroPhase: text('pomodoro_phase').$type<'work' | 'short_break' | 'long_break'>(),
  pomodoroSessionCount: integer('pomodoro_session_count').default(0),
}, (table) => ({
  userIdIdx: index('idx_timers_user_id').on(table.userId),
}))

/**
 * Activity logs table - tracks timer events
 */
export const activityLogs = pgTable('activity_logs', {
  id: text('id').primaryKey(),
  timerId: text('timer_id').notNull(),
  timerName: text('timer_name').notNull(),
  userId: text('user_id').notNull(),
  eventType: text('event_type').notNull().$type<
    'start' | 'pause' | 'reset' | 'lap' | 'complete' | 'time_edit' | 'pomodoro_phase_change'
  >(),
  timestamp: text('timestamp').notNull(), // ISO timestamp

  // Event details
  elapsedAtEvent: integer('elapsed_at_event').notNull().default(0), // milliseconds
  sessionDuration: integer('session_duration'), // milliseconds
  previousValue: integer('previous_value'), // milliseconds
  newValue: integer('new_value'), // milliseconds
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
}, (table) => ({
  userIdIdx: index('idx_activity_logs_user_id').on(table.userId),
  timerIdIdx: index('idx_activity_logs_timer_id').on(table.timerId),
}))

/**
 * Todos table - for example/demo purposes
 * (Not connected to components yet - uses raw SQL)
 */
export const todos = pgTable('todos', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
  completed: integer('completed').notNull().default(0), // 0 = false, 1 = true
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_todos_user_id').on(table.userId),
}))

// ============================================
// Inferred Types
// ============================================

// Timer types
export type Timer = typeof timers.$inferSelect
export type NewTimer = typeof timers.$inferInsert

// Activity log types
export type ActivityLog = typeof activityLogs.$inferSelect
export type NewActivityLog = typeof activityLogs.$inferInsert

// Todo types (not used yet)
export type Todo = typeof todos.$inferSelect
export type NewTodo = typeof todos.$inferInsert
