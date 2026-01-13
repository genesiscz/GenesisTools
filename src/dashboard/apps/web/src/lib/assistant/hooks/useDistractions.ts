import { useState, useEffect } from 'react'
import type { Distraction, DistractionInput } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'
import type { DistractionQueryOptions, DistractionStats } from '@/lib/assistant/lib/storage/types'

/**
 * Hook to log and query distractions
 */
export function useDistractions(userId: string | null) {
  const [distractions, setDistractions] = useState<Distraction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load recent distractions on mount
  useEffect(() => {
    if (!userId) {
      setDistractions([])
      setLoading(false)
      return
    }

    let mounted = true

    async function load() {
      setLoading(true)
      try {
        await initializeAssistantStorage()
        const adapter = getAssistantStorageAdapter()

        // Load last 7 days of distractions
        const endDate = new Date()
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - 7)

        const data = await adapter.getDistractions(userId, { startDate, endDate })
        if (mounted) {
          setDistractions(data)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load distractions')
        }
      } finally {
        if (mounted) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      mounted = false
    }
  }, [userId])

  /**
   * Log a new distraction
   */
  async function logDistraction(input: DistractionInput): Promise<Distraction | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const distraction = await adapter.logDistraction(input, userId)

      // Add to local state
      setDistractions((prev) => [distraction, ...prev])

      return distraction
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log distraction')
      return null
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
    setDistractions((prev) =>
      prev.map((d) => (d.id === distractionId ? { ...d, resumedTask: true } : d))
    )
    // Note: We don't have an update method in the adapter, so this is just local state
  }

  /**
   * Get distractions with filters
   */
  async function getDistractions(options?: DistractionQueryOptions): Promise<Distraction[]> {
    if (!userId) return []

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getDistractions(userId, options)
    } catch {
      return []
    }
  }

  /**
   * Get distraction statistics
   */
  async function getStats(startDate: Date, endDate: Date): Promise<DistractionStats | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getDistractionStats(userId, startDate, endDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get distraction stats')
      return null
    }
  }

  /**
   * Get today's distractions
   */
  function getTodayDistractions(): Distraction[] {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return distractions.filter((d) => new Date(d.timestamp) >= today)
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
   * Compares this week to last week
   */
  async function getDistractionTrend(): Promise<'improving' | 'worsening' | 'stable'> {
    if (!userId) return 'stable'

    const now = new Date()
    const startOfThisWeek = new Date(now)
    startOfThisWeek.setDate(now.getDate() - now.getDay())
    startOfThisWeek.setHours(0, 0, 0, 0)

    const startOfLastWeek = new Date(startOfThisWeek)
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7)

    try {
      const adapter = getAssistantStorageAdapter()

      const thisWeek = await adapter.getDistractions(userId, {
        startDate: startOfThisWeek,
        endDate: now,
      })

      const lastWeek = await adapter.getDistractions(userId, {
        startDate: startOfLastWeek,
        endDate: startOfThisWeek,
      })

      // Normalize by days passed
      const daysPassed = Math.ceil((now.getTime() - startOfThisWeek.getTime()) / (1000 * 60 * 60 * 24))
      const thisWeekDaily = thisWeek.length / Math.max(daysPassed, 1)
      const lastWeekDaily = lastWeek.length / 7

      const diff = thisWeekDaily - lastWeekDaily
      if (diff < -1) return 'improving'
      if (diff > 1) return 'worsening'
      return 'stable'
    } catch {
      return 'stable'
    }
  }

  /**
   * Clear error
   */
  function clearError() {
    setError(null)
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
  }
}
