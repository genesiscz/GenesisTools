// TODO: Update field names to match @dashboard/shared types and add pomodoro support
// Will be used by PowerSyncAdapter in /routes/timer/lib/storage/

import { z } from 'zod'
import { db, APP_SCHEMA } from '@/lib/db/powersync'

/**
 * Timer Schema for validation and type inference
 *
 * This schema defines the structure of timer data as it's used in the app.
 * It handles the transformation from SQLite types (integers for booleans,
 * JSON strings for arrays) to proper TypeScript types.
 */
export const timerSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['stopwatch', 'countdown']),
  is_running: z.number().transform((val) => val > 0), // SQLite int → boolean
  paused_time: z.number(),
  countdown_duration: z.number(),
  laps: z.string().transform((val) => JSON.parse(val || '[]') as number[]),
  user_id: z.string(),
  created_at: z.string().transform((val) => new Date(val)),
  updated_at: z.string().transform((val) => new Date(val)),
})

export type TimerRecord = z.output<typeof timerSchema>

/**
 * Raw timer type as stored in SQLite
 */
export interface TimerRow {
  id: string
  name: string
  type: 'stopwatch' | 'countdown'
  is_running: number
  paused_time: number
  countdown_duration: number
  laps: string
  user_id: string
  created_at: string
  updated_at: string
}

/**
 * Timer input type for creating/updating timers
 */
export interface TimerInput {
  id?: string
  name: string
  type: 'stopwatch' | 'countdown'
  isRunning?: boolean
  pausedTime?: number
  countdownDuration?: number
  laps?: number[]
}

/**
 * Serialize a timer for storage in SQLite
 */
export function serializeTimer(input: TimerInput, userId: string): Omit<TimerRow, 'id'> {
  const now = new Date().toISOString()
  return {
    name: input.name,
    type: input.type,
    is_running: input.isRunning ? 1 : 0,
    paused_time: input.pausedTime ?? 0,
    countdown_duration: input.countdownDuration ?? 5 * 60 * 1000, // 5 min default
    laps: JSON.stringify(input.laps ?? []),
    user_id: userId,
    created_at: now,
    updated_at: now,
  }
}

/**
 * Timer Collection Queries
 *
 * These functions provide typed access to the timers table.
 * They use PowerSync's reactive queries for real-time updates.
 */

/**
 * Get all timers for a user
 */
export async function getTimers(userId: string): Promise<TimerRecord[]> {
  const results = await db.getAll<TimerRow>(
    'SELECT * FROM timers WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  )
  return results.map((row) => timerSchema.parse(row))
}

/**
 * Get a single timer by ID
 */
export async function getTimer(id: string): Promise<TimerRecord | null> {
  const result = await db.getOptional<TimerRow>(
    'SELECT * FROM timers WHERE id = ?',
    [id]
  )
  return result ? timerSchema.parse(result) : null
}

/**
 * Create a new timer
 */
export async function createTimer(input: TimerInput, userId: string): Promise<string> {
  const id = input.id ?? crypto.randomUUID()
  const data = serializeTimer(input, userId)

  await db.execute(
    `INSERT INTO timers (id, name, type, is_running, paused_time, countdown_duration, laps, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.name, data.type, data.is_running, data.paused_time, data.countdown_duration, data.laps, data.user_id, data.created_at, data.updated_at]
  )

  return id
}

/**
 * Update a timer
 */
export async function updateTimer(id: string, updates: Partial<TimerInput>): Promise<void> {
  const setClauses: string[] = []
  const values: (string | number)[] = []

  if (updates.name !== undefined) {
    setClauses.push('name = ?')
    values.push(updates.name)
  }
  if (updates.type !== undefined) {
    setClauses.push('type = ?')
    values.push(updates.type)
  }
  if (updates.isRunning !== undefined) {
    setClauses.push('is_running = ?')
    values.push(updates.isRunning ? 1 : 0)
  }
  if (updates.pausedTime !== undefined) {
    setClauses.push('paused_time = ?')
    values.push(updates.pausedTime)
  }
  if (updates.countdownDuration !== undefined) {
    setClauses.push('countdown_duration = ?')
    values.push(updates.countdownDuration)
  }
  if (updates.laps !== undefined) {
    setClauses.push('laps = ?')
    values.push(JSON.stringify(updates.laps))
  }

  // Always update the timestamp
  setClauses.push('updated_at = ?')
  values.push(new Date().toISOString())

  values.push(id)

  await db.execute(
    `UPDATE timers SET ${setClauses.join(', ')} WHERE id = ?`,
    values
  )
}

/**
 * Delete a timer
 */
export async function deleteTimer(id: string): Promise<void> {
  await db.execute('DELETE FROM timers WHERE id = ?', [id])
}

/**
 * Watch timers for real-time updates
 * Returns a function to stop watching
 */
export function watchTimers(
  userId: string,
  callback: (timers: TimerRecord[]) => void
): () => void {
  const query = db.watch(
    'SELECT * FROM timers WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
    { tables: ['timers'] }
  )

  // Subscribe to changes
  const subscription = query.subscribe({
    next: (results) => {
      const timers = (results.rows?._array ?? []).map((row: TimerRow) =>
        timerSchema.parse(row)
      )
      callback(timers)
    },
    error: (err) => {
      console.error('Timer watch error:', err)
    },
  })

  // Return unsubscribe function
  return () => subscription.unsubscribe()
}
