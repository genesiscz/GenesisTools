import type {
  Timer,
  TimerInput,
  TimerUpdate,
  ActivityLogEntry,
  ActivityLogInput,
  ActivityLogQueryOptions,
  ProductivityStats,
} from '@dashboard/shared'

/**
 * Storage adapter interface - abstraction over localStorage/PowerSync
 */
export interface StorageAdapter {
  // Timer CRUD operations
  getTimers(userId: string): Promise<Timer[]>
  getTimer(id: string): Promise<Timer | null>
  createTimer(input: TimerInput, userId: string): Promise<Timer>
  updateTimer(id: string, updates: TimerUpdate): Promise<Timer>
  deleteTimer(id: string): Promise<void>

  // Activity Log operations
  logActivity(entry: ActivityLogInput): Promise<ActivityLogEntry>
  getActivityLog(
    userId: string,
    options?: ActivityLogQueryOptions
  ): Promise<ActivityLogEntry[]>
  clearActivityLog(userId: string): Promise<void>

  // Statistics
  getProductivityStats(
    userId: string,
    startDate: Date,
    endDate: Date,
    timerId?: string
  ): Promise<ProductivityStats>

  // Real-time subscriptions
  watchTimers(userId: string, callback: (timers: Timer[]) => void): () => void
  watchActivityLog(
    userId: string,
    callback: (entries: ActivityLogEntry[]) => void
  ): () => void

  // Sync operations
  syncToServer(): Promise<void>
  syncFromServer(userId: string): Promise<void>

  // User session management (for sync)
  setUserId(userId: string): void
  clearSync(): void

  // Initialization
  initialize(): Promise<void>
  isInitialized(): boolean
}

/**
 * Storage mode configuration
 *
 * Both modes sync to backend SQLite. The difference is local storage:
 * - 'localstorage': Browser localStorage + HTTP sync to backend
 * - 'powersync': PowerSync SQLite (offline-first) + automatic sync to backend
 */
export type StorageMode = 'localstorage' | 'powersync'

/**
 * Timer state for in-memory operations
 * Extends Timer with runtime properties
 */
export interface TimerState extends Timer {
  // Computed display time (not persisted)
  displayTime?: number
}

/**
 * Cross-tab sync message types
 */
export type SyncMessageType =
  | 'TIMER_CREATED'
  | 'TIMER_UPDATED'
  | 'TIMER_DELETED'
  | 'TIMERS_SYNC'
  | 'ACTIVITY_LOGGED'

export interface SyncMessage {
  type: SyncMessageType
  payload: unknown
  timestamp: number
  sourceTab: string
}

/**
 * Storage constants
 */
export const STORAGE_KEYS = {
  TIMERS: 'chrono_timers',
  ACTIVITY_LOG: 'chrono_activity_log',
  SETTINGS: 'chrono_settings',
  LAST_SYNC: 'chrono_last_sync',
} as const

export const BROADCAST_CHANNEL_NAME = 'chrono_sync_channel'
