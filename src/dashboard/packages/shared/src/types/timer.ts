import { z } from 'zod'

/**
 * Timer type - either counting up or counting down
 */
export type TimerType = 'stopwatch' | 'countdown'

/**
 * Timer schema for validation
 */
export const timerSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['stopwatch', 'countdown']),
  isRunning: z.boolean(),
  pausedTime: z.number(),
  countdownDuration: z.number(),
  laps: z.array(z.number()),
  userId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
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
  type: string // 'stopwatch' | 'countdown'
  is_running: number // 0 or 1 (SQLite boolean)
  paused_time: number
  countdown_duration: number
  laps: string // JSON stringified array
  user_id: string
  created_at: string // ISO string
  updated_at: string // ISO string
}
