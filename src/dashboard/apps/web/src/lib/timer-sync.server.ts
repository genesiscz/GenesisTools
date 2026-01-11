import { createServerFn } from '@tanstack/react-start'
import { db, timerStatements, activityStatements } from './server-db'
import type { TimerRow, ActivityLogRow } from './server-db'

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

// Convert client timer to database row
function timerToRow(timer: TimerData): Record<string, unknown> {
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
function activityToRow(log: ActivityLogData): Record<string, unknown> {
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
 * Get all timers for a user from the server database
 */
export const getTimersFromServer = createServerFn({
  method: 'GET',
})
  .validator((d: string) => d) // userId
  .handler(async ({ data: userId }) => {
    const rows = timerStatements.getAll.all(userId) as TimerRow[]
    return rows.map(rowToTimer)
  })

/**
 * Get all activity logs for a user from the server database
 */
export const getActivityLogsFromServer = createServerFn({
  method: 'GET',
})
  .validator((d: string) => d) // userId
  .handler(async ({ data: userId }) => {
    const rows = activityStatements.getAll.all(userId) as ActivityLogRow[]
    return rows.map(rowToActivity)
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
    const { userId, timers: clientTimers, activityLogs: clientLogs } = data
    const syncedAt = new Date().toISOString()

    // Get current server state
    const serverTimers = timerStatements.getAll.all(userId) as TimerRow[]
    const serverTimerMap = new Map(serverTimers.map((t) => [t.id, t]))

    // Process client timers - upsert with last-write-wins
    const upsertTimers = db.transaction((timers: TimerData[]) => {
      for (const timer of timers) {
        const serverTimer = serverTimerMap.get(timer.id)

        // If server has newer version, skip client update
        if (serverTimer && new Date(serverTimer.updated_at) > new Date(timer.updatedAt)) {
          continue
        }

        // Upsert client timer to server
        timerStatements.upsert.run(timerToRow(timer))
      }
    })

    upsertTimers(clientTimers)

    // Process activity logs - just insert new ones (they're immutable)
    const insertLogs = db.transaction((logs: ActivityLogData[]) => {
      for (const log of logs) {
        activityStatements.upsert.run(activityToRow(log))
      }
    })

    insertLogs(clientLogs)

    // Return merged state from server
    const mergedTimers = timerStatements.getAll.all(userId) as TimerRow[]
    const mergedLogs = activityStatements.getAll.all(userId) as ActivityLogRow[]

    return {
      timers: mergedTimers.map(rowToTimer),
      activityLogs: mergedLogs.map(rowToActivity),
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
    timerStatements.delete.run(data.timerId)
    return { success: true }
  })
