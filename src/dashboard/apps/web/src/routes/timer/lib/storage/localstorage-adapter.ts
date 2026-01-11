import { generateTimerId, generateActivityLogId } from '@dashboard/shared'
import type {
  Timer,
  TimerInput,
  TimerUpdate,
  ActivityLogEntry,
  ActivityLogInput,
  ActivityLogQueryOptions,
  ProductivityStats,
} from '@dashboard/shared'
import type { StorageAdapter, SyncMessage } from './types'
import { STORAGE_KEYS, BROADCAST_CHANNEL_NAME } from './types'
import { SYNC_CONFIG } from './config'

// Note: debouncedWrite was removed in favor of immediate writes for responsive UI

/**
 * localStorage-based storage adapter with cross-tab synchronization
 */
export class LocalStorageAdapter implements StorageAdapter {
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

    // Setup BroadcastChannel for cross-tab sync
    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      this.broadcastChannel.onmessage = (event) => {
        this.handleSyncMessage(event.data as SyncMessage)
      }
    }

    // Listen for storage events (fallback for older browsers)
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent.bind(this))
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
    const data = this.readStorage<Record<string, Timer>>(STORAGE_KEYS.TIMERS) || {}
    return Object.values(data).filter((t) => t.userId === userId)
  }

  async getTimer(id: string): Promise<Timer | null> {
    const data = this.readStorage<Record<string, Timer>>(STORAGE_KEYS.TIMERS) || {}
    return data[id] || null
  }

  async createTimer(input: TimerInput, userId: string): Promise<Timer> {
    const now = new Date()
    const timer: Timer = {
      ...input,
      id: generateTimerId(),
      userId,
      createdAt: now,
      updatedAt: now,
      laps: input.laps || [],
      showTotal: input.showTotal ?? false,
      firstStartTime: null,
      startTime: null,
      pomodoroSessionCount: input.pomodoroSessionCount ?? 0,
    }

    const data = this.readStorage<Record<string, Timer>>(STORAGE_KEYS.TIMERS) || {}
    data[timer.id] = timer
    this.writeStorage(STORAGE_KEYS.TIMERS, data)

    this.broadcast({ type: 'TIMER_CREATED', payload: timer, timestamp: Date.now(), sourceTab: this.tabId })

    // Pass updated timers directly to avoid re-reading stale data
    const userTimers = Object.values(data).filter((t) => t.userId === userId)
    this.notifyTimerWatchersDirect(userTimers)

    return timer
  }

  async updateTimer(id: string, updates: TimerUpdate): Promise<Timer> {
    const data = this.readStorage<Record<string, Timer>>(STORAGE_KEYS.TIMERS) || {}
    const existing = data[id]

    if (!existing) {
      throw new Error(`Timer ${id} not found`)
    }

    const updated: Timer = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    }

    data[id] = updated
    // Write immediately (not debounced) to avoid race condition with watchers
    this.writeStorage(STORAGE_KEYS.TIMERS, data)

    this.broadcast({ type: 'TIMER_UPDATED', payload: updated, timestamp: Date.now(), sourceTab: this.tabId })

    // Pass updated timers directly to avoid re-reading stale data
    const userTimers = Object.values(data).filter((t) => t.userId === existing.userId)
    this.notifyTimerWatchersDirect(userTimers)

    return updated
  }

  async deleteTimer(id: string): Promise<void> {
    const data = this.readStorage<Record<string, Timer>>(STORAGE_KEYS.TIMERS) || {}
    const timer = data[id]

    if (timer) {
      const userId = timer.userId
      delete data[id]
      this.writeStorage(STORAGE_KEYS.TIMERS, data)
      this.broadcast({ type: 'TIMER_DELETED', payload: { id }, timestamp: Date.now(), sourceTab: this.tabId })

      // Pass updated timers directly to avoid re-reading stale data
      const userTimers = Object.values(data).filter((t) => t.userId === userId)
      this.notifyTimerWatchersDirect(userTimers)
    }
  }

  // ============================================
  // Activity Log Operations
  // ============================================

  async logActivity(input: ActivityLogInput): Promise<ActivityLogEntry> {
    const entry: ActivityLogEntry = {
      ...input,
      id: generateActivityLogId(),
    }

    const data = this.readStorage<ActivityLogEntry[]>(STORAGE_KEYS.ACTIVITY_LOG) || []
    data.unshift(entry) // Add to beginning (most recent first)

    // Prune old entries
    const pruned = this.pruneActivityLog(data)
    this.writeStorage(STORAGE_KEYS.ACTIVITY_LOG, pruned)

    this.broadcast({ type: 'ACTIVITY_LOGGED', payload: entry, timestamp: Date.now(), sourceTab: this.tabId })
    this.notifyActivityWatchers(input.userId)

    return entry
  }

  async getActivityLog(
    userId: string,
    options?: ActivityLogQueryOptions
  ): Promise<ActivityLogEntry[]> {
    const data = this.readStorage<ActivityLogEntry[]>(STORAGE_KEYS.ACTIVITY_LOG) || []

    let filtered = data.filter((e) => e.userId === userId)

    if (options?.timerId) {
      filtered = filtered.filter((e) => e.timerId === options.timerId)
    }

    if (options?.eventTypes?.length) {
      filtered = filtered.filter((e) => options.eventTypes!.includes(e.eventType))
    }

    if (options?.startDate) {
      filtered = filtered.filter((e) => new Date(e.timestamp) >= options.startDate!)
    }

    if (options?.endDate) {
      filtered = filtered.filter((e) => new Date(e.timestamp) <= options.endDate!)
    }

    if (options?.offset) {
      filtered = filtered.slice(options.offset)
    }

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit)
    }

    return filtered
  }

  async clearActivityLog(userId: string): Promise<void> {
    const data = this.readStorage<ActivityLogEntry[]>(STORAGE_KEYS.ACTIVITY_LOG) || []
    const filtered = data.filter((e) => e.userId !== userId)
    this.writeStorage(STORAGE_KEYS.ACTIVITY_LOG, filtered)
    this.notifyActivityWatchers(userId)
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

    // Calculate stats from pause events (which have session duration)
    for (const log of logs) {
      if (log.eventType === 'pause' && log.sessionDuration !== undefined) {
        totalTimeTracked += log.sessionDuration
        sessionCount++
        longestSession = Math.max(longestSession, log.sessionDuration)

        // Timer breakdown
        timerBreakdown[log.timerId] = (timerBreakdown[log.timerId] || 0) + log.sessionDuration

        // Daily breakdown
        const dateKey = new Date(log.timestamp).toISOString().split('T')[0]
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

    // Initial call
    this.getTimers(userId).then(callback)

    return () => {
      this.timerWatchers.delete(watcherId)
    }
  }

  watchActivityLog(
    userId: string,
    callback: (entries: ActivityLogEntry[]) => void
  ): () => void {
    const watcherId = `${userId}_${Date.now()}`
    this.activityWatchers.set(watcherId, callback)

    // Initial call
    this.getActivityLog(userId).then(callback)

    return () => {
      this.activityWatchers.delete(watcherId)
    }
  }

  // ============================================
  // Sync Operations (stub for localStorage - real sync in PowerSync adapter)
  // ============================================

  async syncToServer(): Promise<void> {
    // TODO: Implement HTTP sync to server
    console.log('[LocalStorage] syncToServer not implemented')
  }

  async syncFromServer(): Promise<void> {
    // TODO: Implement HTTP sync from server
    console.log('[LocalStorage] syncFromServer not implemented')
  }

  setUserId(_userId: string): void {
    // No-op for localStorage - sync not implemented
  }

  clearSync(): void {
    // No-op for localStorage - sync not implemented
  }

  // ============================================
  // Private Helpers
  // ============================================

  private readStorage<T>(key: string): T | null {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      return JSON.parse(raw, this.dateReviver) as T
    } catch {
      return null
    }
  }

  private writeStorage(key: string, data: unknown): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, JSON.stringify(data))
  }

  private dateReviver(_key: string, value: unknown): unknown {
    // Convert ISO date strings back to Date objects for specific fields
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return new Date(value)
    }
    return value
  }

  private broadcast(message: SyncMessage): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage(message)
    }
  }

  private handleSyncMessage(message: SyncMessage): void {
    // Ignore messages from this tab
    if (message.sourceTab === this.tabId) return

    switch (message.type) {
      case 'TIMER_CREATED':
      case 'TIMER_UPDATED':
      case 'TIMER_DELETED':
      case 'TIMERS_SYNC': {
        const timer = message.payload as Timer
        if (timer?.userId) {
          this.notifyTimerWatchers(timer.userId)
        }
        break
      }
      case 'ACTIVITY_LOGGED': {
        const entry = message.payload as ActivityLogEntry
        if (entry?.userId) {
          this.notifyActivityWatchers(entry.userId)
        }
        break
      }
    }
  }

  private handleStorageEvent(event: StorageEvent): void {
    if (event.key === STORAGE_KEYS.TIMERS || event.key === STORAGE_KEYS.ACTIVITY_LOG) {
      // Notify all watchers - we don't know which user changed
      for (const callback of this.timerWatchers.values()) {
        // Re-read and notify
        const data = this.readStorage<Record<string, Timer>>(STORAGE_KEYS.TIMERS) || {}
        callback(Object.values(data))
      }
      for (const callback of this.activityWatchers.values()) {
        const data = this.readStorage<ActivityLogEntry[]>(STORAGE_KEYS.ACTIVITY_LOG) || []
        callback(data)
      }
    }
  }

  private notifyTimerWatchers(userId: string): void {
    this.getTimers(userId).then((timers) => {
      for (const callback of this.timerWatchers.values()) {
        callback(timers)
      }
    })
  }

  /**
   * Notify watchers with timers directly (avoids re-reading from storage)
   * Use this for same-tab updates where we already have the updated data
   */
  private notifyTimerWatchersDirect(timers: Timer[]): void {
    for (const callback of this.timerWatchers.values()) {
      callback(timers)
    }
  }

  private notifyActivityWatchers(userId: string): void {
    this.getActivityLog(userId).then((entries) => {
      for (const callback of this.activityWatchers.values()) {
        callback(entries)
      }
    })
  }

  private pruneActivityLog(entries: ActivityLogEntry[]): ActivityLogEntry[] {
    // Limit by count
    let pruned = entries.slice(0, SYNC_CONFIG.MAX_ACTIVITY_LOG_ENTRIES)

    // Limit by age
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - SYNC_CONFIG.ACTIVITY_LOG_RETENTION_DAYS)

    pruned = pruned.filter((e) => new Date(e.timestamp) >= cutoff)

    return pruned
  }
}
