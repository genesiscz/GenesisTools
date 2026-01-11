import { useState, useEffect, useRef } from 'react'
import type { ActivityLogEntry, ActivityLogQueryOptions, ProductivityStats } from '@dashboard/shared'
import { getStorageAdapter, initializeStorage } from '../lib/storage'

interface UseActivityLogOptions {
  userId: string | null
  autoRefresh?: boolean
  refreshInterval?: number
}

interface UseActivityLogReturn {
  entries: ActivityLogEntry[]
  loading: boolean
  error: string | null
  // Query methods
  getEntries: (options?: ActivityLogQueryOptions) => Promise<ActivityLogEntry[]>
  getStats: (startDate: Date, endDate: Date) => Promise<ProductivityStats | null>
  // Actions
  clearAll: () => Promise<void>
  refresh: () => Promise<void>
  // Filtering state
  filter: ActivityLogFilter
  setFilter: (filter: Partial<ActivityLogFilter>) => void
}

export interface ActivityLogFilter {
  timerId?: string
  eventTypes?: Array<'start' | 'pause' | 'reset' | 'lap' | 'complete' | 'time_edit' | 'pomodoro_phase_change'>
  startDate?: Date
  endDate?: Date
  limit?: number
}

/**
 * Hook for managing activity log data and filtering
 */
export function useActivityLog({
  userId,
  autoRefresh = false,
  refreshInterval = 30000,
}: UseActivityLogOptions): UseActivityLogReturn {
  const [entries, setEntries] = useState<ActivityLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilterState] = useState<ActivityLogFilter>({})

  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Initialize and subscribe to activity log updates
  useEffect(() => {
    if (!userId) return

    // Capture userId as non-null for use inside async function
    const currentUserId = userId
    let mounted = true

    async function init() {
      setLoading(true)
      try {
        const adapter = await initializeStorage()
        const initialEntries = await adapter.getActivityLog(currentUserId, filter)
        if (mounted) {
          setEntries(initialEntries)
          setLoading(false)
        }

        // Subscribe to updates
        unsubscribeRef.current = adapter.watchActivityLog(currentUserId, (updatedEntries) => {
          if (mounted) {
            // Apply current filter to watched entries
            const filtered = applyFilter(updatedEntries, filter)
            setEntries(filtered)
          }
        })
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load activity log')
          setLoading(false)
        }
      }
    }

    init()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [userId])

  // Refresh entries when filter changes
  useEffect(() => {
    if (!userId) return

    const currentUserId = userId

    async function fetchFiltered() {
      try {
        const adapter = getStorageAdapter()
        const filtered = await adapter.getActivityLog(currentUserId, filter)
        setEntries(filtered)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to filter activity log')
      }
    }

    fetchFiltered()
  }, [userId, filter.timerId, filter.eventTypes?.join(','), filter.startDate?.getTime(), filter.endDate?.getTime(), filter.limit])

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh || !userId) return

    const interval = setInterval(async () => {
      try {
        const adapter = getStorageAdapter()
        const refreshed = await adapter.getActivityLog(userId, filter)
        setEntries(refreshed)
      } catch {
        // Silent fail for auto-refresh
      }
    }, refreshInterval)

    return () => clearInterval(interval)
  }, [autoRefresh, refreshInterval, userId, filter])

  // Get entries with custom options
  async function getEntries(options?: ActivityLogQueryOptions): Promise<ActivityLogEntry[]> {
    if (!userId) return []
    try {
      const adapter = getStorageAdapter()
      return await adapter.getActivityLog(userId, options)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get entries')
      return []
    }
  }

  // Get productivity stats
  async function getStats(startDate: Date, endDate: Date): Promise<ProductivityStats | null> {
    if (!userId) return null
    try {
      const adapter = getStorageAdapter()
      return await adapter.getProductivityStats(userId, startDate, endDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get stats')
      return null
    }
  }

  // Clear all activity log entries
  async function clearAll(): Promise<void> {
    if (!userId) return
    try {
      const adapter = getStorageAdapter()
      await adapter.clearActivityLog(userId)
      setEntries([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear activity log')
    }
  }

  // Refresh entries
  async function refresh(): Promise<void> {
    if (!userId) return
    setLoading(true)
    try {
      const adapter = getStorageAdapter()
      const refreshed = await adapter.getActivityLog(userId, filter)
      setEntries(refreshed)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh activity log')
    } finally {
      setLoading(false)
    }
  }

  // Update filter
  function setFilter(newFilter: Partial<ActivityLogFilter>) {
    setFilterState((prev) => ({ ...prev, ...newFilter }))
  }

  return {
    entries,
    loading,
    error,
    getEntries,
    getStats,
    clearAll,
    refresh,
    filter,
    setFilter,
  }
}

/**
 * Helper to apply filter to entries client-side
 */
function applyFilter(entries: ActivityLogEntry[], filter: ActivityLogFilter): ActivityLogEntry[] {
  let result = entries

  if (filter.timerId) {
    result = result.filter((e) => e.timerId === filter.timerId)
  }

  if (filter.eventTypes?.length) {
    result = result.filter((e) => filter.eventTypes!.includes(e.eventType as typeof filter.eventTypes[number]))
  }

  if (filter.startDate) {
    result = result.filter((e) => new Date(e.timestamp) >= filter.startDate!)
  }

  if (filter.endDate) {
    result = result.filter((e) => new Date(e.timestamp) <= filter.endDate!)
  }

  if (filter.limit) {
    result = result.slice(0, filter.limit)
  }

  return result
}

/**
 * Get today's date range
 */
export function getTodayRange(): { start: Date; end: Date } {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

/**
 * Get this week's date range
 */
export function getWeekRange(): { start: Date; end: Date } {
  const now = new Date()
  const start = new Date(now)
  start.setDate(now.getDate() - now.getDay())
  start.setHours(0, 0, 0, 0)
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

/**
 * Get this month's date range
 */
export function getMonthRange(): { start: Date; end: Date } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return { start, end }
}
