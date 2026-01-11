import { z } from 'zod'

/**
 * Timer type - stopwatch, countdown, or pomodoro
 */
export type TimerType = 'stopwatch' | 'countdown' | 'pomodoro'

/**
 * Pomodoro phase - work or break
 */
export type PomodoroPhase = 'work' | 'short_break' | 'long_break'

/**
 * Pomodoro settings schema
 */
export const pomodoroSettingsSchema = z.object({
  workDuration: z.number().default(25 * 60 * 1000), // 25 minutes
  shortBreakDuration: z.number().default(5 * 60 * 1000), // 5 minutes
  longBreakDuration: z.number().default(15 * 60 * 1000), // 15 minutes
  sessionsBeforeLongBreak: z.number().default(4),
})

export type PomodoroSettings = z.infer<typeof pomodoroSettingsSchema>

/**
 * Lap entry with timing details
 */
export const lapEntrySchema = z.object({
  number: z.number(), // Lap number (1-based)
  lapTime: z.number(), // Time for this individual lap in ms
  splitTime: z.number(), // Total elapsed time at this lap in ms
  timestamp: z.date(), // When lap was recorded
})

export type LapEntry = z.infer<typeof lapEntrySchema>

/**
 * Timer schema for validation
 */
export const timerSchema = z.object({
  id: z.string(),
  name: z.string(),
  timerType: z.enum(['stopwatch', 'countdown', 'pomodoro']),
  isRunning: z.boolean(),
  elapsedTime: z.number(), // Accumulated elapsed time in ms (when paused)
  duration: z.number().optional(), // For countdown/pomodoro timers
  laps: z.array(lapEntrySchema),
  userId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  // Enhanced functionality
  showTotal: z.boolean().default(false), // Toggle total time display
  firstStartTime: z.date().nullable().default(null), // First time timer was started
  startTime: z.date().nullable().default(null), // Current session start time
  // Pomodoro-specific fields
  pomodoroSettings: pomodoroSettingsSchema.optional(),
  pomodoroPhase: z.enum(['work', 'short_break', 'long_break']).optional(),
  pomodoroSessionCount: z.number().default(0),
})

/**
 * Timer interface - represents a single timer instance
 */
export type Timer = z.infer<typeof timerSchema>

/**
 * Timer input for creating a new timer
 */
export const timerInputSchema = timerSchema.omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
})

export type TimerInput = z.infer<typeof timerInputSchema>

/**
 * Timer update - partial timer for updates
 */
export const timerUpdateSchema = timerInputSchema.partial()

export type TimerUpdate = z.infer<typeof timerUpdateSchema>

/**
 * Serialized timer for storage (SQLite/PowerSync)
 * Uses SQLite-compatible types
 */
export interface SerializedTimer {
  id: string
  name: string
  timer_type: string // 'stopwatch' | 'countdown' | 'pomodoro'
  is_running: number // 0 or 1 (SQLite boolean)
  elapsed_time: number
  duration: number | null
  laps: string // JSON stringified array of LapEntry
  user_id: string
  created_at: string // ISO string
  updated_at: string // ISO string
  show_total: number // 0 or 1
  first_start_time: string | null // ISO string
  start_time: string | null // ISO string
  pomodoro_settings: string | null // JSON stringified PomodoroSettings
  pomodoro_phase: string | null
  pomodoro_session_count: number
}

/**
 * Default pomodoro settings
 */
export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workDuration: 25 * 60 * 1000, // 25 minutes
  shortBreakDuration: 5 * 60 * 1000, // 5 minutes
  longBreakDuration: 15 * 60 * 1000, // 15 minutes
  sessionsBeforeLongBreak: 4,
}

