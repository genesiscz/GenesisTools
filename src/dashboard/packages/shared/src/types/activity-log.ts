import { z } from 'zod'

/**
 * Activity event types for timer actions
 */
export type ActivityEventType =
  | 'start'
  | 'pause'
  | 'reset'
  | 'lap'
  | 'complete'
  | 'time_edit'
  | 'pomodoro_phase_change'

/**
 * Activity log entry schema
 */
export const activityLogEntrySchema = z.object({
  id: z.string(),
  timerId: z.string(),
  timerName: z.string(),
  userId: z.string(),
  eventType: z.enum([
    'start',
    'pause',
    'reset',
    'lap',
    'complete',
    'time_edit',
    'pomodoro_phase_change'
  ]),
  timestamp: z.date(),
  elapsedAtEvent: z.number(), // ms elapsed when event occurred
  sessionDuration: z.number().optional(), // For pause events: duration of this session
  previousValue: z.number().optional(), // For time_edit: previous elapsed time
  newValue: z.number().optional(), // For time_edit: new elapsed time
  metadata: z.record(z.unknown()).optional(),
})

export type ActivityLogEntry = z.infer<typeof activityLogEntrySchema>

/**
 * Activity log input for creating entries
 */
export const activityLogInputSchema = activityLogEntrySchema.omit({
  id: true,
})

export type ActivityLogInput = z.infer<typeof activityLogInputSchema>

/**
 * Serialized activity log for storage
 */
export interface SerializedActivityLog {
  id: string
  timer_id: string
  timer_name: string
  user_id: string
  event_type: string
  timestamp: string // ISO string
  elapsed_at_event: number
  session_duration: number | null
  previous_value: number | null
  new_value: number | null
  metadata: string | null // JSON stringified
}

/**
 * Query options for activity log
 */
export interface ActivityLogQueryOptions {
  timerId?: string
  eventTypes?: ActivityEventType[]
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}

/**
 * Productivity stats for a time period
 */
export interface ProductivityStats {
  totalTimeTracked: number // Total time in ms
  sessionCount: number // Number of start/pause cycles
  averageSessionDuration: number // Average session length
  longestSession: number // Longest single session
  timerBreakdown: Record<string, number> // Time per timer
  dailyBreakdown: Record<string, number> // Time per day (ISO date string)
  pomodoroCompleted: number // Completed pomodoro sessions
}

/**
 * Generate unique activity log ID
 */
export function generateActivityLogId(): string {
  return `log_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}
