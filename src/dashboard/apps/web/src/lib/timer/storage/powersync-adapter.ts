import { db, initializeDatabase, syncToServer } from '@/lib/db/powersync'
import { getTimersFromServer, getActivityLogsFromServer } from '@/lib/timer/timer-sync.server'
import { generateTimerId, generateActivityLogId } from '@dashboard/shared'
import { getEventClient } from '@/lib/events/client'
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
 * - Automatic sync to Nitro backend via connector
 * - Real-time reactive queries
 *
 * Sync flow:
 * 1. Client writes to PowerSync SQLite
 * 2. PowerSync queues changes in CRUD batch
 * 3. Connector uploads batch to /api/sync/upload
 * 4. Nitro applies changes to server SQLite
 */
export class PowerSyncAdapter implements StorageAdapter {
  private initialized = false
  private broadcastChannel: BroadcastChannel | null = null
  private tabId: string
  private timerWatchers: Map<string, (timers: Timer[]) => void> = new Map()
  private activityWatchers: Map<string, (entries: ActivityLogEntry[]) => void> = new Map()
  private eventClient = getEventClient()
  private eventUnsubscribe: (() => void) | null = null
  private currentUserId: string | null = null
  private initialSyncPromise: Promise<void> | null = null

  constructor() {
    this.tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log('[PowerSyncAdapter] Already initialized')
      return
    }

    console.log('[PowerSyncAdapter] Starting initialization...')

    // Initialize PowerSync database and connect to backend
    await initializeDatabase()
    console.log('[PowerSyncAdapter] Database initialized')

    // Setup BroadcastChannel for cross-tab notifications
    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      this.broadcastChannel.onmessage = (event) => {
        this.handleSyncMessage(event.data as SyncMessage)
      }
    }

    this.initialized = true
    console.log('[PowerSyncAdapter] Initialization complete')
  }

  isInitialized(): boolean {
    return this.initialized
  }

  // ============================================
  // Timer Operations
  // ============================================

  async getTimers(userId: string): Promise<Timer[]> {
    console.log('[PowerSyncAdapter] getTimers called for user:', userId)
    try {
      // Wait for initial sync to complete if it's in progress
      if (this.initialSyncPromise) {
        console.log('[PowerSyncAdapter] Waiting for initial sync to complete...')
        await this.initialSyncPromise
        this.initialSyncPromise = null
      }

      const results = await db.getAll<TimerRow>(
        'SELECT * FROM timers WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      )

      console.log('[PowerSyncAdapter] getTimers returned', results.length, 'timers')
      return results.map(deserializeTimer)
    } catch (err) {
      console.error('[PowerSyncAdapter] getTimers error:', err)
      throw err
    }
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

    // Sync to server
    console.log('[PowerSyncAdapter] Triggering sync to server after create')
    syncToServer().catch(err => {
      console.error('[PowerSyncAdapter] Sync failed after create:', err)
    })

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

    // Sync to server
    syncToServer()

    return updated!
  }

  async deleteTimer(id: string): Promise<void> {
    await db.execute('DELETE FROM timers WHERE id = ?', [id])
    this.broadcast({ type: 'TIMER_DELETED', payload: { id }, timestamp: Date.now(), sourceTab: this.tabId })

    // Sync to server
    syncToServer()
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

    // Sync to server
    syncToServer()

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

    // Sync to server
    syncToServer()
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
      if (log.eventType === 'pause' && log.sessionDuration !== undefined) {
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

  /**
   * Set the current user ID and connect to real-time event stream
   * This enables server-to-client synchronization via SSE
   */
  setUserId(userId: string): void {
    this.currentUserId = userId

    // Unsubscribe from previous events
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe()
      this.eventUnsubscribe = null
    }

    // Connect to SSE event stream if not already connected
    if (!this.eventClient.isConnected()) {
      this.eventClient.connect(userId, [`timer:${userId}`])
      console.log('[PowerSyncAdapter] Connected to event stream for user:', userId)
    }

    // Subscribe to timer events from server
    this.eventUnsubscribe = this.eventClient.subscribe(`timer:${userId}`, async (data: unknown) => {
      const event = data as { type: string; timestamp: number }
      console.log('[PowerSyncAdapter] Received server event:', event)

      if (event.type === 'sync') {
        // Server has new data, download from server
        console.log('[PowerSyncAdapter] Server notified of changes, syncing...')
        await this.syncFromServer(userId)
      }
    })

    console.log('[PowerSyncAdapter] Subscribed to timer events for user:', userId)

    // Always sync from server when user ID is set
    // This ensures fresh data when opening new tabs or reloading
    this.initialSyncPromise = this.syncFromServer(userId).catch((err) => {
      console.error('[PowerSyncAdapter] Initial sync failed:', err)
    })
  }

  /**
   * Clear sync state (call on logout)
   * Disconnects from event stream and clears user context
   */
  clearSync(): void {
    // Unsubscribe from events
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe()
      this.eventUnsubscribe = null
    }

    // Note: We don't disconnect the event client here as it's a singleton
    // shared across the application. The client will handle reconnection
    // when setUserId is called again.

    this.currentUserId = null
    console.log('[PowerSyncAdapter] Cleared sync state')
  }

  /**
   * Sync to server - PowerSync handles this automatically
   */
  async syncToServer(): Promise<void> {
    // PowerSync automatically uploads via connector.uploadData()
    console.log('[PowerSync] Sync is automatic via connector')
  }

  /**
   * Sync from server - fetches timers from Nitro backend and populates local DB
   * Called when local DB is empty (e.g., after clearing IndexedDB)
   */
  async syncFromServer(userId: string): Promise<void> {
    console.log('[PowerSyncAdapter] Syncing from server for user:', userId)

    try {
      // Fetch timers from server
      const serverTimers = await getTimersFromServer({ data: userId })
      console.log('[PowerSyncAdapter] Got', serverTimers?.length ?? 0, 'timers from server')

      if (!serverTimers || serverTimers.length === 0) {
        console.log('[PowerSyncAdapter] No timers on server')
        return
      }

      // Insert each timer into local DB (skip if already exists)
      for (const timer of serverTimers) {
        const existing = await db.getOptional<{ id: string }>('SELECT id FROM timers WHERE id = ?', [timer.id])
        if (!existing) {
          await db.execute(
            `INSERT INTO timers (
              id, name, timer_type, is_running, elapsed_time, duration, laps, user_id,
              created_at, updated_at, show_total, first_start_time, start_time,
              pomodoro_settings, pomodoro_phase, pomodoro_session_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              timer.id,
              timer.name,
              timer.timerType,
              timer.isRunning ? 1 : 0,
              timer.elapsedTime,
              timer.duration ?? null,
              JSON.stringify(timer.laps ?? []),
              timer.userId,
              timer.createdAt,
              timer.updatedAt,
              timer.showTotal ? 1 : 0,
              timer.firstStartTime ?? null,
              timer.startTime ?? null,
              timer.pomodoroSettings ? JSON.stringify(timer.pomodoroSettings) : null,
              timer.pomodoroPhase ?? null,
              timer.pomodoroSessionCount ?? 0,
            ]
          )
        }
      }

      // Fetch activity logs from server
      const serverLogs = await getActivityLogsFromServer({ data: userId })
      console.log('[PowerSyncAdapter] Got', serverLogs?.length ?? 0, 'activity logs from server')

      // Insert each log into local DB (skip if already exists)
      if (!serverLogs || serverLogs.length === 0) {
        console.log('[PowerSyncAdapter] No activity logs on server')
        return
      }

      for (const log of serverLogs) {
        const existing = await db.getOptional<{ id: string }>('SELECT id FROM activity_logs WHERE id = ?', [log.id])
        if (!existing) {
          await db.execute(
            `INSERT INTO activity_logs (
              id, timer_id, timer_name, user_id, event_type, timestamp,
              elapsed_at_event, session_duration, previous_value, new_value, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              log.id,
              log.timerId,
              log.timerName,
              log.userId,
              log.eventType,
              log.timestamp,
              log.elapsedAtEvent,
              log.sessionDuration ?? null,
              log.previousValue ?? null,
              log.newValue ?? null,
              log.metadata ? JSON.stringify(log.metadata) : null,
            ]
          )
        }
      }

      console.log('[PowerSyncAdapter] Server sync complete')
    } catch (err) {
      console.error('[PowerSyncAdapter] syncFromServer error:', err)
      // Don't throw - let app continue with local data
    }
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
