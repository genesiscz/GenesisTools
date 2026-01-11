import { db } from '@/db/powersync'
import { generateTimerId, generateActivityLogId } from '@dashboard/shared'
import type {
  Timer,
  TimerInput,
  TimerUpdate,
  ActivityLogEntry,
  ActivityLogInput,
  ActivityLogQueryOptions,
  ProductivityStats,
  LapEntry,
} from '@dashboard/shared'
import type { StorageAdapter, SyncMessage } from './types'
import { BROADCAST_CHANNEL_NAME } from './types'

/**
 * PowerSync-based storage adapter with offline-first SQLite persistence
 *
 * Uses PowerSync for:
 * - Local SQLite storage via @journeyapps/wa-sqlite
 * - Automatic bi-directional sync with backend
 * - Real-time reactive queries
 */
export class PowerSyncAdapter implements StorageAdapter {
  private initialized = false
  private broadcastChannel: BroadcastChannel | null = null
  private tabId: string
  private timerWatchers: Map<string, (timers: Timer[]) => void> = new Map()
  private activityWatchers: Map<string, (entries: ActivityLogEntry[]) => void> = new Map()

  constructor() {
    this.tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    // Initialize PowerSync database
    await db.init()

    // Setup BroadcastChannel for cross-tab notifications
    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      this.broadcastChannel.onmessage = (event) => {
        this.handleSyncMessage(event.data as SyncMessage)
      }
    }

    this.initialized = true
  }

  isInitialized(): boolean {
    return this.initialized
  }

  // ============================================
  // Timer Operations
  // ============================================

  async getTimers(userId: string): Promise<Timer[]> {
    const results = await db.getAll<TimerRow>(
      'SELECT * FROM timers WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    )
    return results.map(deserializeTimer)
  }

  async getTimer(id: string): Promise<Timer | null> {
    const result = await db.getOptional<TimerRow>('SELECT * FROM timers WHERE id = ?', [id])
    return result ? deserializeTimer(result) : null
  }

  async createTimer(input: TimerInput, userId: string): Promise<Timer> {
    const now = new Date()
    const id = generateTimerId()

    const row: TimerRow = {
      id,
      name: input.name,
      timer_type: input.timerType,
      is_running: input.isRunning ? 1 : 0,
      elapsed_time: input.elapsedTime ?? 0,
      duration: input.duration ?? null,
      laps: JSON.stringify(input.laps ?? []),
      user_id: userId,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      show_total: (input.showTotal ?? false) ? 1 : 0,
      first_start_time: input.firstStartTime?.toISOString() ?? null,
      start_time: input.startTime?.toISOString() ?? null,
      pomodoro_settings: input.pomodoroSettings ? JSON.stringify(input.pomodoroSettings) : null,
      pomodoro_phase: input.pomodoroPhase ?? null,
      pomodoro_session_count: input.pomodoroSessionCount ?? 0,
    }

    await db.execute(
      `INSERT INTO timers (
        id, name, timer_type, is_running, elapsed_time, duration, laps, user_id,
        created_at, updated_at, show_total, first_start_time, start_time,
        pomodoro_settings, pomodoro_phase, pomodoro_session_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.timer_type,
        row.is_running,
        row.elapsed_time,
        row.duration,
        row.laps,
        row.user_id,
        row.created_at,
        row.updated_at,
        row.show_total,
        row.first_start_time,
        row.start_time,
        row.pomodoro_settings,
        row.pomodoro_phase,
        row.pomodoro_session_count,
      ]
    )

    const timer = deserializeTimer(row)
    this.broadcast({ type: 'TIMER_CREATED', payload: timer, timestamp: Date.now(), sourceTab: this.tabId })

    return timer
  }

  async updateTimer(id: string, updates: TimerUpdate): Promise<Timer> {
    const existing = await this.getTimer(id)
    if (!existing) {
      throw new Error(`Timer ${id} not found`)
    }

    const setClauses: string[] = []
    const values: (string | number | null)[] = []

    if (updates.name !== undefined) {
      setClauses.push('name = ?')
      values.push(updates.name)
    }
    if (updates.timerType !== undefined) {
      setClauses.push('timer_type = ?')
      values.push(updates.timerType)
    }
    if (updates.isRunning !== undefined) {
      setClauses.push('is_running = ?')
      values.push(updates.isRunning ? 1 : 0)
    }
    if (updates.elapsedTime !== undefined) {
      setClauses.push('elapsed_time = ?')
      values.push(updates.elapsedTime)
    }
    if (updates.duration !== undefined) {
      setClauses.push('duration = ?')
      values.push(updates.duration)
    }
    if (updates.laps !== undefined) {
      setClauses.push('laps = ?')
      values.push(JSON.stringify(updates.laps))
    }
    if (updates.showTotal !== undefined) {
      setClauses.push('show_total = ?')
      values.push(updates.showTotal ? 1 : 0)
    }
    if (updates.firstStartTime !== undefined) {
      setClauses.push('first_start_time = ?')
      values.push(updates.firstStartTime?.toISOString() ?? null)
    }
    if (updates.startTime !== undefined) {
      setClauses.push('start_time = ?')
      values.push(updates.startTime?.toISOString() ?? null)
    }
    if (updates.pomodoroSettings !== undefined) {
      setClauses.push('pomodoro_settings = ?')
      values.push(updates.pomodoroSettings ? JSON.stringify(updates.pomodoroSettings) : null)
    }
    if (updates.pomodoroPhase !== undefined) {
      setClauses.push('pomodoro_phase = ?')
      values.push(updates.pomodoroPhase ?? null)
    }
    if (updates.pomodoroSessionCount !== undefined) {
      setClauses.push('pomodoro_session_count = ?')
      values.push(updates.pomodoroSessionCount)
    }

    // Always update timestamp
    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())

    values.push(id)

    await db.execute(`UPDATE timers SET ${setClauses.join(', ')} WHERE id = ?`, values)

    const updated = await this.getTimer(id)
    if (updated) {
      this.broadcast({ type: 'TIMER_UPDATED', payload: updated, timestamp: Date.now(), sourceTab: this.tabId })
    }

    return updated!
  }

  async deleteTimer(id: string): Promise<void> {
    await db.execute('DELETE FROM timers WHERE id = ?', [id])
    this.broadcast({ type: 'TIMER_DELETED', payload: { id }, timestamp: Date.now(), sourceTab: this.tabId })
  }

  // ============================================
  // Activity Log Operations
  // ============================================

  async logActivity(input: ActivityLogInput): Promise<ActivityLogEntry> {
    const entry: ActivityLogEntry = {
      ...input,
      id: generateActivityLogId(),
    }

    await db.execute(
      `INSERT INTO activity_logs (
        id, timer_id, timer_name, user_id, event_type, timestamp,
        elapsed_at_event, session_duration, previous_value, new_value, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.timerId,
        entry.timerName,
        entry.userId,
        entry.eventType,
        entry.timestamp.toISOString(),
        entry.elapsedAtEvent,
        entry.sessionDuration ?? null,
        entry.previousValue ?? null,
        entry.newValue ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    )

    this.broadcast({ type: 'ACTIVITY_LOGGED', payload: entry, timestamp: Date.now(), sourceTab: this.tabId })

    return entry
  }

  async getActivityLog(userId: string, options?: ActivityLogQueryOptions): Promise<ActivityLogEntry[]> {
    let query = 'SELECT * FROM activity_logs WHERE user_id = ?'
    const params: (string | number)[] = [userId]

    if (options?.timerId) {
      query += ' AND timer_id = ?'
      params.push(options.timerId)
    }

    if (options?.eventTypes?.length) {
      const placeholders = options.eventTypes.map(() => '?').join(', ')
      query += ` AND event_type IN (${placeholders})`
      params.push(...options.eventTypes)
    }

    if (options?.startDate) {
      query += ' AND timestamp >= ?'
      params.push(options.startDate.toISOString())
    }

    if (options?.endDate) {
      query += ' AND timestamp <= ?'
      params.push(options.endDate.toISOString())
    }

    query += ' ORDER BY timestamp DESC'

    if (options?.limit) {
      query += ' LIMIT ?'
      params.push(options.limit)
    }

    if (options?.offset) {
      query += ' OFFSET ?'
      params.push(options.offset)
    }

    const results = await db.getAll<ActivityLogRow>(query, params)
    return results.map(deserializeActivityLog)
  }

  async clearActivityLog(userId: string): Promise<void> {
    await db.execute('DELETE FROM activity_logs WHERE user_id = ?', [userId])
  }

  // ============================================
  // Statistics
  // ============================================

  async getProductivityStats(
    userId: string,
    startDate: Date,
    endDate: Date,
    timerId?: string
  ): Promise<ProductivityStats> {
    const logs = await this.getActivityLog(userId, { startDate, endDate, timerId })

    let totalTimeTracked = 0
    let sessionCount = 0
    let longestSession = 0
    let pomodoroCompleted = 0
    const timerBreakdown: Record<string, number> = {}
    const dailyBreakdown: Record<string, number> = {}

    for (const log of logs) {
      if (log.eventType === 'pause' && log.sessionDuration) {
        totalTimeTracked += log.sessionDuration
        sessionCount++
        longestSession = Math.max(longestSession, log.sessionDuration)

        timerBreakdown[log.timerId] = (timerBreakdown[log.timerId] || 0) + log.sessionDuration

        const dateKey = log.timestamp.toISOString().split('T')[0]
        dailyBreakdown[dateKey] = (dailyBreakdown[dateKey] || 0) + log.sessionDuration
      }

      if (log.eventType === 'complete' && log.metadata?.pomodoroPhase === 'work') {
        pomodoroCompleted++
      }
    }

    return {
      totalTimeTracked,
      sessionCount,
      averageSessionDuration: sessionCount > 0 ? totalTimeTracked / sessionCount : 0,
      longestSession,
      timerBreakdown,
      dailyBreakdown,
      pomodoroCompleted,
    }
  }

  // ============================================
  // Watchers
  // ============================================

  watchTimers(userId: string, callback: (timers: Timer[]) => void): () => void {
    const watcherId = `${userId}_${Date.now()}`
    this.timerWatchers.set(watcherId, callback)

    // Use PowerSync's reactive watch
    const query = db.watch('SELECT * FROM timers WHERE user_id = ? ORDER BY created_at DESC', [userId], {
      tables: ['timers'],
    })

    // PowerSync watch returns an async iterable
    const processResults = async () => {
      try {
        for await (const result of query) {
          const rows = (result as { rows?: { _array?: TimerRow[] } }).rows?._array ?? []
          const timers = rows.map(deserializeTimer)
          callback(timers)
        }
      } catch (err) {
        console.error('[PowerSync] Timer watch error:', err)
      }
    }

    processResults()

    return () => {
      this.timerWatchers.delete(watcherId)
    }
  }

  watchActivityLog(userId: string, callback: (entries: ActivityLogEntry[]) => void): () => void {
    const watcherId = `${userId}_${Date.now()}`
    this.activityWatchers.set(watcherId, callback)

    const query = db.watch('SELECT * FROM activity_logs WHERE user_id = ? ORDER BY timestamp DESC', [userId], {
      tables: ['activity_logs'],
    })

    const processResults = async () => {
      try {
        for await (const result of query) {
          const rows = (result as { rows?: { _array?: ActivityLogRow[] } }).rows?._array ?? []
          const entries = rows.map(deserializeActivityLog)
          callback(entries)
        }
      } catch (err) {
        console.error('[PowerSync] Activity log watch error:', err)
      }
    }

    processResults()

    return () => {
      this.activityWatchers.delete(watcherId)
    }
  }

  // ============================================
  // Sync Operations
  // ============================================

  async syncToServer(): Promise<void> {
    // PowerSync handles sync automatically when connected
    // This is a no-op as sync is continuous
    console.log('[PowerSync] Sync is handled automatically')
  }

  async syncFromServer(): Promise<void> {
    // PowerSync handles sync automatically when connected
    console.log('[PowerSync] Sync is handled automatically')
  }

  // ============================================
  // Private Helpers
  // ============================================

  private broadcast(message: SyncMessage): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage(message)
    }
  }

  private handleSyncMessage(message: SyncMessage): void {
    if (message.sourceTab === this.tabId) return
    // PowerSync handles data sync, but we can use broadcast for UI notifications
  }
}

// ============================================
// Type Definitions for SQLite Rows
// ============================================

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
  metadata: string | null
}

// ============================================
// Serialization Helpers
// ============================================

function deserializeTimer(row: TimerRow): Timer {
  return {
    id: row.id,
    name: row.name,
    timerType: row.timer_type as Timer['timerType'],
    isRunning: row.is_running > 0,
    elapsedTime: row.elapsed_time,
    duration: row.duration ?? undefined,
    laps: JSON.parse(row.laps || '[]') as LapEntry[],
    userId: row.user_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    showTotal: row.show_total > 0,
    firstStartTime: row.first_start_time ? new Date(row.first_start_time) : null,
    startTime: row.start_time ? new Date(row.start_time) : null,
    pomodoroSettings: row.pomodoro_settings ? JSON.parse(row.pomodoro_settings) : undefined,
    pomodoroPhase: row.pomodoro_phase as Timer['pomodoroPhase'],
    pomodoroSessionCount: row.pomodoro_session_count,
  }
}

function deserializeActivityLog(row: ActivityLogRow): ActivityLogEntry {
  return {
    id: row.id,
    timerId: row.timer_id,
    timerName: row.timer_name,
    userId: row.user_id,
    eventType: row.event_type as ActivityLogEntry['eventType'],
    timestamp: new Date(row.timestamp),
    elapsedAtEvent: row.elapsed_at_event,
    sessionDuration: row.session_duration ?? undefined,
    previousValue: row.previous_value ?? undefined,
    newValue: row.new_value ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  }
}
