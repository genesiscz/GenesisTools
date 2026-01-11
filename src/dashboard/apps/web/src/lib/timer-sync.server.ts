import { createServerFn } from '@tanstack/react-start'
import { useDatabase } from 'nitro/database'

// Types matching the client-side Timer type
interface TimerData {
  id: string
  name: string
  timerType: 'stopwatch' | 'countdown' | 'pomodoro'
  isRunning: boolean
  elapsedTime: number
  duration?: number
  laps: Array<{ id: string; time: number; delta: number }>
  userId: string
  createdAt: string
  updatedAt: string
  showTotal: boolean
  firstStartTime?: string
  startTime?: string
  pomodoroSettings?: {
    workDuration: number
    shortBreakDuration: number
    longBreakDuration: number
    sessionsBeforeLongBreak: number
  }
  pomodoroPhase?: 'work' | 'short_break' | 'long_break'
  pomodoroSessionCount: number
}

interface ActivityLogData {
  id: string
  timerId: string
  timerName: string
  userId: string
  eventType: string
  timestamp: string
  elapsedAtEvent: number
  sessionDuration?: number
  previousValue?: number
  newValue?: number
  metadata?: Record<string, unknown>
}

interface SyncInput {
  userId: string
  timers: TimerData[]
  activityLogs: ActivityLogData[]
  lastSyncAt?: string
}

interface SyncOutput {
  timers: TimerData[]
  activityLogs: ActivityLogData[]
  syncedAt: string
}

// Database row types
interface TimerRow {
  id: string
  name: string
  timer_type: string
  is_running: number
  elapsed_time: number
  duration: number | null
  laps: string
  user_id: string
  created_at: string
  updated_at: string
  show_total: number
  first_start_time: string | null
  start_time: string | null
  pomodoro_settings: string | null
  pomodoro_phase: string | null
  pomodoro_session_count: number
}

interface ActivityLogRow {
  id: string
  timer_id: string
  timer_name: string
  user_id: string
  event_type: string
  timestamp: string
  elapsed_at_event: number
  session_duration: number | null
  previous_value: number | null
  new_value: number | null
  metadata: string
}

// Convert client timer to database row values
function timerToRow(timer: TimerData): TimerRow {
  return {
    id: timer.id,
    name: timer.name,
    timer_type: timer.timerType,
    is_running: timer.isRunning ? 1 : 0,
    elapsed_time: timer.elapsedTime,
    duration: timer.duration ?? null,
    laps: JSON.stringify(timer.laps),
    user_id: timer.userId,
    created_at: timer.createdAt,
    updated_at: timer.updatedAt,
    show_total: timer.showTotal ? 1 : 0,
    first_start_time: timer.firstStartTime ?? null,
    start_time: timer.startTime ?? null,
    pomodoro_settings: timer.pomodoroSettings ? JSON.stringify(timer.pomodoroSettings) : null,
    pomodoro_phase: timer.pomodoroPhase ?? null,
    pomodoro_session_count: timer.pomodoroSessionCount ?? 0,
  }
}

// Convert database row to client timer
function rowToTimer(row: TimerRow): TimerData {
  return {
    id: row.id,
    name: row.name,
    timerType: row.timer_type as TimerData['timerType'],
    isRunning: row.is_running === 1,
    elapsedTime: row.elapsed_time,
    duration: row.duration ?? undefined,
    laps: JSON.parse(row.laps || '[]'),
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    showTotal: row.show_total === 1,
    firstStartTime: row.first_start_time ?? undefined,
    startTime: row.start_time ?? undefined,
    pomodoroSettings: row.pomodoro_settings ? JSON.parse(row.pomodoro_settings) : undefined,
    pomodoroPhase: row.pomodoro_phase as TimerData['pomodoroPhase'],
    pomodoroSessionCount: row.pomodoro_session_count,
  }
}

// Convert client activity log to database row
function activityToRow(log: ActivityLogData): ActivityLogRow {
  return {
    id: log.id,
    timer_id: log.timerId,
    timer_name: log.timerName,
    user_id: log.userId,
    event_type: log.eventType,
    timestamp: log.timestamp,
    elapsed_at_event: log.elapsedAtEvent,
    session_duration: log.sessionDuration ?? null,
    previous_value: log.previousValue ?? null,
    new_value: log.newValue ?? null,
    metadata: JSON.stringify(log.metadata || {}),
  }
}

// Convert database row to client activity log
function rowToActivity(row: ActivityLogRow): ActivityLogData {
  return {
    id: row.id,
    timerId: row.timer_id,
    timerName: row.timer_name,
    userId: row.user_id,
    eventType: row.event_type,
    timestamp: row.timestamp,
    elapsedAtEvent: row.elapsed_at_event,
    sessionDuration: row.session_duration ?? undefined,
    previousValue: row.previous_value ?? undefined,
    newValue: row.new_value ?? undefined,
    metadata: JSON.parse(row.metadata || '{}'),
  }
}

/**
 * Initialize database tables
 */
async function ensureTables() {
  const db = useDatabase()

  // Create timers table
  await db.sql`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timer_type TEXT NOT NULL,
      is_running INTEGER NOT NULL DEFAULT 0,
      elapsed_time INTEGER NOT NULL DEFAULT 0,
      duration INTEGER,
      laps TEXT DEFAULT '[]',
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      show_total INTEGER NOT NULL DEFAULT 0,
      first_start_time TEXT,
      start_time TEXT,
      pomodoro_settings TEXT,
      pomodoro_phase TEXT,
      pomodoro_session_count INTEGER DEFAULT 0
    )
  `

  // Create activity logs table
  await db.sql`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      timer_id TEXT NOT NULL,
      timer_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      elapsed_at_event INTEGER NOT NULL DEFAULT 0,
      session_duration INTEGER,
      previous_value INTEGER,
      new_value INTEGER,
      metadata TEXT DEFAULT '{}'
    )
  `

  // Create indexes
  await db.sql`CREATE INDEX IF NOT EXISTS idx_timers_user_id ON timers(user_id)`
  await db.sql`CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id)`
  await db.sql`CREATE INDEX IF NOT EXISTS idx_activity_logs_timer_id ON activity_logs(timer_id)`
}

/**
 * Get all timers for a user from the server database
 */
export const getTimersFromServer = createServerFn({
  method: 'GET',
})
  .validator((d: string) => d) // userId
  .handler(async ({ data: userId }) => {
    await ensureTables()
    const db = useDatabase()

    const { rows } = await db.sql<TimerRow>`
      SELECT * FROM timers WHERE user_id = ${userId} ORDER BY created_at DESC
    `

    return (rows ?? []).map(rowToTimer)
  })

/**
 * Get all activity logs for a user from the server database
 */
export const getActivityLogsFromServer = createServerFn({
  method: 'GET',
})
  .validator((d: string) => d) // userId
  .handler(async ({ data: userId }) => {
    await ensureTables()
    const db = useDatabase()

    const { rows } = await db.sql<ActivityLogRow>`
      SELECT * FROM activity_logs WHERE user_id = ${userId} ORDER BY timestamp DESC LIMIT 1000
    `

    return (rows ?? []).map(rowToActivity)
  })

/**
 * Full sync - upload local changes and download server changes
 * Uses last-write-wins conflict resolution based on updatedAt timestamp
 */
export const syncTimers = createServerFn({
  method: 'POST',
})
  .validator((d: SyncInput) => d)
  .handler(async ({ data }): Promise<SyncOutput> => {
    await ensureTables()
    const db = useDatabase()

    const { userId, timers: clientTimers, activityLogs: clientLogs } = data
    const syncedAt = new Date().toISOString()

    // Get current server state
    const { rows: serverTimerRows } = await db.sql<TimerRow>`
      SELECT * FROM timers WHERE user_id = ${userId}
    `
    const serverTimerMap = new Map((serverTimerRows ?? []).map((t) => [t.id, t]))

    // Process client timers - upsert with last-write-wins
    for (const timer of clientTimers) {
      const serverTimer = serverTimerMap.get(timer.id)

      // If server has newer version, skip client update
      if (serverTimer && new Date(serverTimer.updated_at) > new Date(timer.updatedAt)) {
        continue
      }

      const row = timerToRow(timer)

      // Upsert using INSERT OR REPLACE
      await db.sql`
        INSERT OR REPLACE INTO timers (
          id, name, timer_type, is_running, elapsed_time, duration, laps,
          user_id, created_at, updated_at, show_total, first_start_time,
          start_time, pomodoro_settings, pomodoro_phase, pomodoro_session_count
        ) VALUES (
          ${row.id}, ${row.name}, ${row.timer_type}, ${row.is_running}, ${row.elapsed_time},
          ${row.duration}, ${row.laps}, ${row.user_id}, ${row.created_at}, ${row.updated_at},
          ${row.show_total}, ${row.first_start_time}, ${row.start_time},
          ${row.pomodoro_settings}, ${row.pomodoro_phase}, ${row.pomodoro_session_count}
        )
      `
    }

    // Process activity logs - just insert new ones (they're immutable)
    for (const log of clientLogs) {
      const row = activityToRow(log)

      // Insert if not exists
      await db.sql`
        INSERT OR IGNORE INTO activity_logs (
          id, timer_id, timer_name, user_id, event_type, timestamp,
          elapsed_at_event, session_duration, previous_value, new_value, metadata
        ) VALUES (
          ${row.id}, ${row.timer_id}, ${row.timer_name}, ${row.user_id}, ${row.event_type},
          ${row.timestamp}, ${row.elapsed_at_event}, ${row.session_duration},
          ${row.previous_value}, ${row.new_value}, ${row.metadata}
        )
      `
    }

    // Return merged state from server
    const { rows: mergedTimerRows } = await db.sql<TimerRow>`
      SELECT * FROM timers WHERE user_id = ${userId} ORDER BY created_at DESC
    `
    const { rows: mergedLogRows } = await db.sql<ActivityLogRow>`
      SELECT * FROM activity_logs WHERE user_id = ${userId} ORDER BY timestamp DESC LIMIT 1000
    `

    return {
      timers: (mergedTimerRows ?? []).map(rowToTimer),
      activityLogs: (mergedLogRows ?? []).map(rowToActivity),
      syncedAt,
    }
  })

/**
 * Delete a timer from the server database
 */
export const deleteTimerFromServer = createServerFn({
  method: 'POST',
})
  .validator((d: { timerId: string; userId: string }) => d)
  .handler(async ({ data }) => {
    await ensureTables()
    const db = useDatabase()

    await db.sql`DELETE FROM timers WHERE id = ${data.timerId}`

    return { success: true }
  })
