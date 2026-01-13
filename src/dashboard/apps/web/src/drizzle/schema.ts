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
// Assistant Tables
// ============================================

/**
 * Assistant Tasks - core task management
 */
export const assistantTasks = pgTable('assistant_tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  projectId: text('project_id'),

  // Deadline hierarchy
  deadline: text('deadline'), // ISO timestamp
  urgencyLevel: text('urgency_level').notNull().$type<'critical' | 'important' | 'nice-to-have'>().default('nice-to-have'),
  isShippingBlocker: integer('is_shipping_blocker').notNull().default(0), // 0 = false, 1 = true

  // Context management
  contextParkingLot: text('context_parking_lot'),
  linkedGitHub: text('linked_github'),

  // Dependencies
  blockedBy: jsonb('blocked_by').$type<string[]>().default([]),
  blocks: jsonb('blocks').$type<string[]>().default([]),

  // Status & tracking
  status: text('status').notNull().$type<'backlog' | 'in-progress' | 'blocked' | 'completed'>().default('backlog'),
  completedAt: text('completed_at'), // ISO timestamp
  focusTimeLogged: integer('focus_time_logged').notNull().default(0), // minutes

  // Timestamps
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_tasks_user_id').on(table.userId),
}))

/**
 * Context Parking - captures working memory when switching tasks
 */
export const assistantContextParking = pgTable('assistant_context_parking', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  content: text('content').notNull(),

  // Code context (JSONB)
  codeContext: jsonb('code_context').$type<{
    filePath?: string
    lineNumber?: number
    snippet?: string
  }>(),

  discoveryNotes: text('discovery_notes'),
  nextSteps: text('next_steps'),

  // Status
  status: text('status').notNull().$type<'active' | 'resumed' | 'archived'>().default('active'),

  // Timestamps
  parkedAt: text('parked_at').notNull(), // ISO timestamp
  resumedAt: text('resumed_at'), // ISO timestamp
  createdAt: text('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_context_parking_user_id').on(table.userId),
  taskIdIdx: index('idx_assistant_context_parking_task_id').on(table.taskId),
}))

/**
 * Completion Events - tracks task completions for celebrations
 */
export const assistantCompletions = pgTable('assistant_completions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  completionType: text('completion_type').notNull().$type<'task-complete' | 'focus-session' | 'streak-milestone' | 'badge-earned'>(),
  completedAt: text('completed_at').notNull(), // ISO timestamp
  celebrationShown: integer('celebration_shown').notNull().default(0), // 0 = false, 1 = true

  // Metadata
  metadata: jsonb('metadata').$type<{
    focusTimeSpent?: number
    taskUrgency?: 'critical' | 'important' | 'nice-to-have'
    currentStreak?: number
    totalTasksCompleted?: number
    badgeName?: string
  }>().default({}),
}, (table) => ({
  userIdIdx: index('idx_assistant_completions_user_id').on(table.userId),
}))

/**
 * Streaks - user streak tracking
 */
export const assistantStreaks = pgTable('assistant_streaks', {
  userId: text('user_id').primaryKey(),
  currentStreakDays: integer('current_streak_days').notNull().default(0),
  longestStreakDays: integer('longest_streak_days').notNull().default(0),
  lastTaskCompletionDate: text('last_task_completion_date').notNull(), // ISO timestamp
  streakResetDate: text('streak_reset_date'), // ISO timestamp
})

/**
 * Badges - user earned badges
 */
export const assistantBadges = pgTable('assistant_badges', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  badgeType: text('badge_type').notNull().$type<
    | 'task-master-10' | 'task-master-50' | 'task-master-100'
    | 'streak-3' | 'streak-7' | 'streak-14' | 'streak-30'
    | 'first-task' | 'first-critical' | 'context-keeper'
    | 'focus-warrior' | 'decision-maker' | 'communicator' | 'deep-worker'
  >(),
  earnedAt: text('earned_at').notNull(), // ISO timestamp
  displayName: text('display_name').notNull(),
  rarity: text('rarity').notNull().$type<'common' | 'uncommon' | 'rare' | 'legendary'>(),
}, (table) => ({
  userIdIdx: index('idx_assistant_badges_user_id').on(table.userId),
}))

/**
 * Communication Log - captures discussions and context from various sources
 */
export const assistantCommunications = pgTable('assistant_communications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  source: text('source').notNull().$type<'slack' | 'github' | 'email' | 'meeting' | 'manual'>(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  sourceUrl: text('source_url'),
  discussedAt: text('discussed_at').notNull(), // ISO timestamp
  tags: jsonb('tags').$type<string[]>().default([]),
  relatedTaskIds: jsonb('related_task_ids').$type<string[]>().default([]),
  sentiment: text('sentiment').notNull().$type<'decision' | 'discussion' | 'blocker' | 'context'>().default('context'),

  // Timestamps
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_communications_user_id').on(table.userId),
}))

/**
 * Decision Log - records technical and process decisions
 */
export const assistantDecisions = pgTable('assistant_decisions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  reasoning: text('reasoning').notNull(),
  alternativesConsidered: jsonb('alternatives_considered').$type<string[]>().default([]),
  decidedAt: text('decided_at').notNull(), // ISO timestamp
  decidedBy: text('decided_by').notNull(),
  status: text('status').notNull().$type<'active' | 'superseded' | 'reversed'>().default('active'),
  supersededBy: text('superseded_by'), // Decision ID
  reversalReason: text('reversal_reason'),
  impactArea: text('impact_area').notNull().$type<'frontend' | 'backend' | 'infrastructure' | 'process' | 'architecture' | 'product'>(),
  relatedTaskIds: jsonb('related_task_ids').$type<string[]>().default([]),
  tags: jsonb('tags').$type<string[]>().default([]),

  // Timestamps
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_decisions_user_id').on(table.userId),
}))

/**
 * Task Blockers - tracks why a task is blocked
 */
export const assistantBlockers = pgTable('assistant_blockers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  reason: text('reason').notNull(),
  blockedSince: text('blocked_since').notNull(), // ISO timestamp
  blockerOwner: text('blocker_owner'),
  followUpAction: text('follow_up_action').$type<'remind' | 'switch' | 'wait'>(),
  reminderSet: text('reminder_set'), // ISO timestamp
  unblockedAt: text('unblocked_at'), // ISO timestamp

  // Timestamps
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_blockers_user_id').on(table.userId),
  taskIdIdx: index('idx_assistant_blockers_task_id').on(table.taskId),
}))

/**
 * Handoff Documents - structured documents for handing off work
 */
export const assistantHandoffs = pgTable('assistant_handoffs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  handedOffFrom: text('handed_off_from').notNull(),
  handedOffTo: text('handed_off_to').notNull(),
  handoffAt: text('handoff_at').notNull(), // ISO timestamp
  summary: text('summary').notNull(),
  contextNotes: text('context_notes').notNull(),
  decisions: jsonb('decisions').$type<string[]>().default([]), // Decision IDs
  blockers: jsonb('blockers').$type<string[]>().default([]), // Blocker IDs
  nextSteps: jsonb('next_steps').$type<string[]>().default([]),
  gotchas: text('gotchas'),
  contact: text('contact').notNull(),
  reviewed: integer('reviewed').notNull().default(0), // 0 = false, 1 = true
  reviewedAt: text('reviewed_at'), // ISO timestamp

  // Timestamps
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_handoffs_user_id').on(table.userId),
  taskIdIdx: index('idx_assistant_handoffs_task_id').on(table.taskId),
}))

/**
 * Deadline Risks - calculated risk assessments for task deadlines
 */
export const assistantDeadlineRisks = pgTable('assistant_deadline_risks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  taskId: text('task_id').notNull(),
  riskLevel: text('risk_level').notNull().$type<'green' | 'yellow' | 'red'>(),
  projectedCompletionDate: text('projected_completion_date').notNull(), // ISO timestamp
  daysLate: integer('days_late').notNull().default(0),
  daysRemaining: integer('days_remaining').notNull().default(0),
  percentComplete: integer('percent_complete').notNull().default(0),
  recommendedOption: text('recommended_option').notNull().$type<'extend' | 'help' | 'scope' | 'accept'>(),
  calculatedAt: text('calculated_at').notNull(), // ISO timestamp

  // Timestamps
  createdAt: text('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_deadline_risks_user_id').on(table.userId),
  taskIdIdx: index('idx_assistant_deadline_risks_task_id').on(table.taskId),
}))

/**
 * Energy Snapshots - captures energy and focus state at points in time
 */
export const assistantEnergySnapshots = pgTable('assistant_energy_snapshots', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  timestamp: text('timestamp').notNull(), // ISO timestamp
  focusQuality: integer('focus_quality').notNull().$type<1 | 2 | 3 | 4 | 5>(),
  contextSwitches: integer('context_switches').notNull().default(0),
  tasksCompleted: integer('tasks_completed').notNull().default(0),
  typeOfWork: text('type_of_work').notNull().$type<'deep-work' | 'communication' | 'admin' | 'meeting'>(),
  notes: text('notes'),

  // Timestamps
  createdAt: text('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_energy_snapshots_user_id').on(table.userId),
}))

/**
 * Distractions - tracks interruptions and their impact
 */
export const assistantDistractions = pgTable('assistant_distractions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  timestamp: text('timestamp').notNull(), // ISO timestamp
  source: text('source').notNull().$type<'slack' | 'email' | 'meeting' | 'coworker' | 'hunger' | 'other'>(),
  description: text('description'),
  duration: integer('duration'), // minutes
  taskInterrupted: text('task_interrupted'), // taskId
  resumedTask: integer('resumed_task').notNull().default(0), // 0 = false, 1 = true

  // Timestamps
  createdAt: text('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_distractions_user_id').on(table.userId),
}))

/**
 * Weekly Reviews - aggregated weekly analytics and insights
 */
export const assistantWeeklyReviews = pgTable('assistant_weekly_reviews', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  weekStart: text('week_start').notNull(), // ISO timestamp
  weekEnd: text('week_end').notNull(), // ISO timestamp
  tasksCompleted: integer('tasks_completed').notNull().default(0),
  tasksCompletedLastWeek: integer('tasks_completed_last_week').notNull().default(0),
  deadlinesHit: integer('deadlines_hit').notNull().default(0),
  deadlinesTotal: integer('deadlines_total').notNull().default(0),
  totalMinutes: integer('total_minutes').notNull().default(0),
  deepFocusMinutes: integer('deep_focus_minutes').notNull().default(0),
  meetingMinutes: integer('meeting_minutes').notNull().default(0),
  averageEnergy: integer('average_energy').notNull().default(0), // Scaled 1-5 * 100 for precision
  energyByDay: jsonb('energy_by_day').$type<Record<string, number>>().default({}),
  peakFocusTime: text('peak_focus_time'),
  lowEnergyTime: text('low_energy_time'),
  insights: jsonb('insights').$type<string[]>().default([]),
  recommendations: jsonb('recommendations').$type<string[]>().default([]),
  badgesEarned: jsonb('badges_earned').$type<string[]>().default([]),
  streakDays: integer('streak_days').notNull().default(0),
  generatedAt: text('generated_at').notNull(), // ISO timestamp

  // Timestamps
  createdAt: text('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_weekly_reviews_user_id').on(table.userId),
}))

/**
 * Celebrations - represents celebrations to show to user
 */
export const assistantCelebrations = pgTable('assistant_celebrations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tier: text('tier').notNull().$type<'micro' | 'badge' | 'full'>(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  triggerType: text('trigger_type').notNull().$type<
    | 'task-complete' | 'focus-session' | 'streak-milestone' | 'badge-earned'
    | 'weekly-review' | 'milestone'
  >(),
  triggerId: text('trigger_id'), // ID of the triggering event
  shownAt: text('shown_at'), // ISO timestamp
  dismissed: integer('dismissed').notNull().default(0), // 0 = false, 1 = true

  // Timestamps
  createdAt: text('created_at').notNull(),
}, (table) => ({
  userIdIdx: index('idx_assistant_celebrations_user_id').on(table.userId),
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

// ============================================
// Assistant Types
// ============================================

// Task types
export type AssistantTask = typeof assistantTasks.$inferSelect
export type NewAssistantTask = typeof assistantTasks.$inferInsert

// Context parking types
export type AssistantContextParking = typeof assistantContextParking.$inferSelect
export type NewAssistantContextParking = typeof assistantContextParking.$inferInsert

// Completion types
export type AssistantCompletion = typeof assistantCompletions.$inferSelect
export type NewAssistantCompletion = typeof assistantCompletions.$inferInsert

// Streak types
export type AssistantStreak = typeof assistantStreaks.$inferSelect
export type NewAssistantStreak = typeof assistantStreaks.$inferInsert

// Badge types
export type AssistantBadge = typeof assistantBadges.$inferSelect
export type NewAssistantBadge = typeof assistantBadges.$inferInsert

// Communication types
export type AssistantCommunication = typeof assistantCommunications.$inferSelect
export type NewAssistantCommunication = typeof assistantCommunications.$inferInsert

// Decision types
export type AssistantDecision = typeof assistantDecisions.$inferSelect
export type NewAssistantDecision = typeof assistantDecisions.$inferInsert

// Blocker types
export type AssistantBlocker = typeof assistantBlockers.$inferSelect
export type NewAssistantBlocker = typeof assistantBlockers.$inferInsert

// Handoff types
export type AssistantHandoff = typeof assistantHandoffs.$inferSelect
export type NewAssistantHandoff = typeof assistantHandoffs.$inferInsert

// Deadline risk types
export type AssistantDeadlineRisk = typeof assistantDeadlineRisks.$inferSelect
export type NewAssistantDeadlineRisk = typeof assistantDeadlineRisks.$inferInsert

// Energy snapshot types
export type AssistantEnergySnapshot = typeof assistantEnergySnapshots.$inferSelect
export type NewAssistantEnergySnapshot = typeof assistantEnergySnapshots.$inferInsert

// Distraction types
export type AssistantDistraction = typeof assistantDistractions.$inferSelect
export type NewAssistantDistraction = typeof assistantDistractions.$inferInsert

// Weekly review types
export type AssistantWeeklyReview = typeof assistantWeeklyReviews.$inferSelect
export type NewAssistantWeeklyReview = typeof assistantWeeklyReviews.$inferInsert

// Celebration types
export type AssistantCelebration = typeof assistantCelebrations.$inferSelect
export type NewAssistantCelebration = typeof assistantCelebrations.$inferInsert
