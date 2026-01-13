/**
 * Distractions Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Distraction, DistractionInput } from '@/lib/assistant/types'
import { generateDistractionId } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'
import type { DistractionQueryOptions, DistractionStats } from '@/lib/assistant/lib/storage/types'
import {
  useAssistantDistractionsQuery,
  useCreateAssistantDistractionMutation,
  assistantKeys,
} from './useAssistantQueries'

/**
 * Hook to log and query distractions
 * Server-first with localStorage fallback
 */
export function useDistractions(userId: string | null) {
  const queryClient = useQueryClient()
  const [fallbackMode, setFallbackMode] = useState(false)
  const [fallbackDistractions, setFallbackDistractions] = useState<Distraction[]>([])
  const [error, setError] = useState<string | null>(null)

  // Server queries
  const distractionsQuery = useAssistantDistractionsQuery(userId, 100)

  // Server mutations
  const createMutation = useCreateAssistantDistractionMutation()

  // Determine if we should use fallback mode
  const useFallback = fallbackMode || (distractionsQuery.isError && !distractionsQuery.data)

  // Initialize localStorage fallback if server fails
  useEffect(() => {
    if (!userId) return

    if (distractionsQuery.isError && !fallbackMode) {
      const currentUserId = userId

      async function loadFallback() {
        try {
          const adapter = await initializeAssistantStorage()
          const endDate = new Date()
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - 7)

          const data = await adapter.getDistractions(currentUserId, { startDate, endDate })
          setFallbackMode(true)
          setFallbackDistractions(data)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load fallback')
        }
      }

      loadFallback()
    }
  }, [userId, distractionsQuery.isError, fallbackMode])

  // Convert server distractions to app Distraction type
  const distractions: Distraction[] = useMemo(() => {
    if (useFallback) return fallbackDistractions

    return (distractionsQuery.data ?? []).map((d) => ({
      id: d.id,
      userId: d.userId,
      source: d.source as Distraction['source'],
      taskInterrupted: d.taskInterrupted ?? undefined,
      duration: d.duration ?? undefined,
      resumedTask: d.resumedTask === 1,
      timestamp: new Date(d.timestamp),
      createdAt: new Date(d.createdAt),
    }))
  }, [useFallback, fallbackDistractions, distractionsQuery.data])

  // Loading state
  const loading = distractionsQuery.isLoading

  /**
   * Log a new distraction
   */
  async function logDistraction(input: DistractionInput): Promise<Distraction | null> {
    if (!userId) return null

    const now = new Date()
    const distractionId = generateDistractionId()

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        const distraction = await adapter.logDistraction(input, userId)
        setFallbackDistractions((prev) => [distraction, ...prev])
        return distraction
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to log distraction')
        return null
      }
    }

    try {
      const result = await createMutation.mutateAsync({
        id: distractionId,
        userId,
        source: input.source,
        taskInterrupted: input.taskInterrupted ?? null,
        duration: input.duration ?? null,
        resumedTask: input.resumedTask ? 1 : 0,
        timestamp: now.toISOString(),
        createdAt: now.toISOString(),
      })

      if (!result) throw new Error('Failed to log distraction')

      return {
        id: result.id,
        userId,
        source: input.source,
        taskInterrupted: input.taskInterrupted,
        duration: input.duration,
        resumedTask: input.resumedTask ?? false,
        timestamp: now,
        createdAt: now,
      }
    } catch (err) {
      // Fall back to localStorage on error
      try {
        const adapter = await initializeAssistantStorage()
        const distraction = await adapter.logDistraction(input, userId)
        setFallbackDistractions((prev) => [distraction, ...prev])
        return distraction
      } catch {
        setError(err instanceof Error ? err.message : 'Failed to log distraction')
        return null
      }
    }
  }

  /**
   * Quick log distraction (simplified)
   */
  async function quickLog(
    source: Distraction['source'],
    taskInterrupted?: string
  ): Promise<Distraction | null> {
    return logDistraction({
      source,
      taskInterrupted,
      resumedTask: false,
    })
  }

  /**
   * Mark that user resumed task after distraction
   */
  async function markResumed(distractionId: string): Promise<void> {
    if (useFallback) {
      setFallbackDistractions((prev) =>
        prev.map((d) => (d.id === distractionId ? { ...d, resumedTask: true } : d))
      )
    }
    // Note: Server mode doesn't have update endpoint, so just update local cache
  }

  /**
   * Get distractions with filters (local filtering)
   */
  async function getDistractions(options?: DistractionQueryOptions): Promise<Distraction[]> {
    if (!userId) return []

    let filtered = [...distractions]

    if (options?.startDate) {
      filtered = filtered.filter((d) => d.timestamp >= options.startDate!)
    }
    if (options?.endDate) {
      filtered = filtered.filter((d) => d.timestamp <= options.endDate!)
    }
    if (options?.source) {
      filtered = filtered.filter((d) => d.source === options.source)
    }
    if (options?.taskId) {
      filtered = filtered.filter((d) => d.taskInterrupted === options.taskId)
    }

    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get distraction statistics
   */
  async function getStats(startDate: Date, endDate: Date): Promise<DistractionStats | null> {
    if (!userId) return null

    const filtered = distractions.filter(
      (d) => d.timestamp >= startDate && d.timestamp <= endDate
    )

    if (filtered.length === 0) {
      return {
        total: 0,
        bySource: {},
        averageDuration: 0,
        resumptionRate: 0,
        peakHour: 0,
      }
    }

    // Compute stats
    const bySource: Record<string, number> = {}
    const hourCounts: Record<number, number> = {}
    let totalDuration = 0
    let durationCount = 0
    let resumedCount = 0

    for (const d of filtered) {
      bySource[d.source] = (bySource[d.source] || 0) + 1

      const hour = d.timestamp.getHours()
      hourCounts[hour] = (hourCounts[hour] || 0) + 1

      if (d.duration) {
        totalDuration += d.duration
        durationCount++
      }

      if (d.resumedTask) {
        resumedCount++
      }
    }

    // Find peak hour
    let peakHour = 0
    let peakCount = 0
    for (const [hour, count] of Object.entries(hourCounts)) {
      if (count > peakCount) {
        peakCount = count
        peakHour = parseInt(hour)
      }
    }

    return {
      total: filtered.length,
      bySource,
      averageDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      resumptionRate: (resumedCount / filtered.length) * 100,
      peakHour,
    }
  }

  /**
   * Get today's distractions
   */
  function getTodayDistractions(): Distraction[] {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return distractions.filter((d) => d.timestamp >= today)
  }

  /**
   * Get distractions by source
   */
  function getBySource(source: Distraction['source']): Distraction[] {
    return distractions.filter((d) => d.source === source)
  }

  /**
   * Get distractions that interrupted a specific task
   */
  function getByTask(taskId: string): Distraction[] {
    return distractions.filter((d) => d.taskInterrupted === taskId)
  }

  /**
   * Get distraction count for today
   */
  function getTodayCount(): number {
    return getTodayDistractions().length
  }

  /**
   * Get most common distraction source
   */
  function getMostCommonSource(): Distraction['source'] | null {
    if (distractions.length === 0) return null

    const counts: Record<string, number> = {}
    for (const d of distractions) {
      counts[d.source] = (counts[d.source] || 0) + 1
    }

    let maxSource: string | null = null
    let maxCount = 0
    for (const [source, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count
        maxSource = source
      }
    }

    return maxSource as Distraction['source']
  }

  /**
   * Get distraction source icon
   */
  function getSourceIcon(source: Distraction['source']): string {
    switch (source) {
      case 'slack':
        return 'MessageSquare'
      case 'email':
        return 'Mail'
      case 'meeting':
        return 'Users'
      case 'coworker':
        return 'User'
      case 'hunger':
        return 'Coffee'
      case 'other':
        return 'AlertCircle'
    }
  }

  /**
   * Get distraction source label
   */
  function getSourceLabel(source: Distraction['source']): string {
    switch (source) {
      case 'slack':
        return 'Slack/Chat'
      case 'email':
        return 'Email'
      case 'meeting':
        return 'Unplanned Meeting'
      case 'coworker':
        return 'Coworker Interruption'
      case 'hunger':
        return 'Hunger/Break'
      case 'other':
        return 'Other'
    }
  }

  /**
   * Get resumption rate (percentage of distractions where task was resumed)
   */
  function getResumptionRate(): number {
    if (distractions.length === 0) return 0
    const resumed = distractions.filter((d) => d.resumedTask).length
    return (resumed / distractions.length) * 100
  }

  /**
   * Get total distraction duration today
   */
  function getTodayDurationMinutes(): number {
    return getTodayDistractions().reduce((sum, d) => sum + (d.duration ?? 0), 0)
  }

  /**
   * Format distraction duration
   */
  function formatDuration(minutes: number | undefined): string {
    if (!minutes) return 'Unknown'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }

  /**
   * Get distraction trend (improving, worsening, stable)
   */
  async function getDistractionTrend(): Promise<'improving' | 'worsening' | 'stable'> {
    if (!userId) return 'stable'

    const now = new Date()
    const startOfThisWeek = new Date(now)
    startOfThisWeek.setDate(now.getDate() - now.getDay())
    startOfThisWeek.setHours(0, 0, 0, 0)

    const startOfLastWeek = new Date(startOfThisWeek)
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7)

    const thisWeek = distractions.filter(
      (d) => d.timestamp >= startOfThisWeek && d.timestamp <= now
    )

    const lastWeek = distractions.filter(
      (d) => d.timestamp >= startOfLastWeek && d.timestamp < startOfThisWeek
    )

    // Normalize by days passed
    const daysPassed = Math.ceil((now.getTime() - startOfThisWeek.getTime()) / (1000 * 60 * 60 * 24))
    const thisWeekDaily = thisWeek.length / Math.max(daysPassed, 1)
    const lastWeekDaily = lastWeek.length / 7

    const diff = thisWeekDaily - lastWeekDaily
    if (diff < -1) return 'improving'
    if (diff > 1) return 'worsening'
    return 'stable'
  }

  /**
   * Clear error
   */
  function clearError() {
    setError(null)
  }

  /**
   * Manual refresh
   */
  function refresh() {
    if (userId) {
      queryClient.invalidateQueries({ queryKey: assistantKeys.distractionList(userId) })
    }
  }

  return {
    // State
    distractions,
    loading,
    error,

    // Operations
    logDistraction,
    quickLog,
    markResumed,
    getDistractions,
    getStats,

    // Filters
    getTodayDistractions,
    getBySource,
    getByTask,

    // Analytics
    getTodayCount,
    getMostCommonSource,
    getResumptionRate,
    getTodayDurationMinutes,
    getDistractionTrend,

    // Utilities
    getSourceIcon,
    getSourceLabel,
    formatDuration,
    clearError,
    refresh,

    // Server status
    isServerMode: !useFallback,
  }
}
