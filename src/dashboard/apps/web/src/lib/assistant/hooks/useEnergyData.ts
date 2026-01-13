/**
 * Energy Data Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useState, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { EnergySnapshot, EnergySnapshotInput, FocusQuality } from '@/lib/assistant/types'
import { generateEnergySnapshotId } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'
import type {
  EnergyQueryOptions,
  EnergyHeatmapData,
} from '@/lib/assistant/lib/storage/types'
import {
  useAssistantEnergySnapshotsQuery,
  useCreateAssistantEnergySnapshotMutation,
  assistantKeys,
} from './useAssistantQueries'

/**
 * Hook to manage energy snapshots and compute heatmap data
 * Server-first with localStorage fallback
 */
export function useEnergyData(userId: string | null) {
  const queryClient = useQueryClient()
  const [fallbackMode, setFallbackMode] = useState(false)
  const [fallbackSnapshots, setFallbackSnapshots] = useState<EnergySnapshot[]>([])
  const [error, setError] = useState<string | null>(null)

  // Server queries
  const snapshotsQuery = useAssistantEnergySnapshotsQuery(userId, 100)

  // Server mutations
  const createMutation = useCreateAssistantEnergySnapshotMutation()

  // Determine if we should use fallback mode
  const useFallback = fallbackMode || (snapshotsQuery.isError && !snapshotsQuery.data)

  // Initialize localStorage fallback if server fails
  useEffect(() => {
    if (!userId) return

    if (snapshotsQuery.isError && !fallbackMode) {
      const currentUserId = userId

      async function loadFallback() {
        try {
          const adapter = await initializeAssistantStorage()
          const endDate = new Date()
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - 30)

          const data = await adapter.getEnergySnapshots(currentUserId, { startDate, endDate })
          setFallbackMode(true)
          setFallbackSnapshots(data)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load fallback')
        }
      }

      loadFallback()
    }
  }, [userId, snapshotsQuery.isError, fallbackMode])

  // Convert server snapshots to app EnergySnapshot type
  const snapshots: EnergySnapshot[] = useMemo(() => {
    if (useFallback) return fallbackSnapshots

    return (snapshotsQuery.data ?? []).map((s) => ({
      id: s.id,
      userId: s.userId,
      timestamp: new Date(s.timestamp),
      focusQuality: s.focusQuality as FocusQuality,
      contextSwitches: s.contextSwitches,
      tasksCompleted: s.tasksCompleted,
      typeOfWork: s.typeOfWork as EnergySnapshot['typeOfWork'],
      notes: s.notes ?? undefined,
      createdAt: new Date(s.createdAt),
    }))
  }, [useFallback, fallbackSnapshots, snapshotsQuery.data])

  // Loading state
  const loading = snapshotsQuery.isLoading

  /**
   * Log a new energy snapshot
   */
  async function logSnapshot(input: EnergySnapshotInput): Promise<EnergySnapshot | null> {
    if (!userId) return null

    const now = new Date()
    const snapshotId = generateEnergySnapshotId()

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        const snapshot = await adapter.logEnergySnapshot(input, userId)
        setFallbackSnapshots((prev) => [snapshot, ...prev])
        return snapshot
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to log energy snapshot')
        return null
      }
    }

    try {
      const result = await createMutation.mutateAsync({
        id: snapshotId,
        userId,
        timestamp: input.timestamp?.toISOString() ?? now.toISOString(),
        focusQuality: input.focusQuality,
        contextSwitches: input.contextSwitches ?? 0,
        tasksCompleted: input.tasksCompleted ?? 0,
        typeOfWork: input.typeOfWork,
        notes: input.notes ?? null,
        createdAt: now.toISOString(),
      })

      if (!result) throw new Error('Failed to log energy snapshot')

      return {
        id: result.id,
        userId,
        timestamp: input.timestamp ?? now,
        focusQuality: input.focusQuality,
        contextSwitches: input.contextSwitches ?? 0,
        tasksCompleted: input.tasksCompleted ?? 0,
        typeOfWork: input.typeOfWork,
        notes: input.notes,
        createdAt: now,
      }
    } catch (err) {
      // Fall back to localStorage on error
      try {
        const adapter = await initializeAssistantStorage()
        const snapshot = await adapter.logEnergySnapshot(input, userId)
        setFallbackSnapshots((prev) => [snapshot, ...prev])
        return snapshot
      } catch {
        setError(err instanceof Error ? err.message : 'Failed to log energy snapshot')
        return null
      }
    }
  }

  /**
   * Get energy snapshots with filters (local filtering)
   */
  async function getSnapshots(options?: EnergyQueryOptions): Promise<EnergySnapshot[]> {
    if (!userId) return []

    let filtered = [...snapshots]

    if (options?.startDate) {
      filtered = filtered.filter((s) => s.timestamp >= options.startDate!)
    }
    if (options?.endDate) {
      filtered = filtered.filter((s) => s.timestamp <= options.endDate!)
    }
    if (options?.workType) {
      filtered = filtered.filter((s) => s.typeOfWork === options.workType)
    }
    if (options?.minQuality) {
      filtered = filtered.filter((s) => s.focusQuality >= options.minQuality!)
    }

    return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get heatmap data for visualization
   */
  async function getHeatmapData(startDate: Date, endDate: Date): Promise<EnergyHeatmapData | null> {
    if (!userId) return null

    // For now, compute from local snapshots
    const filtered = snapshots.filter(
      (s) => s.timestamp >= startDate && s.timestamp <= endDate
    )

    if (filtered.length === 0) {
      return {
        hourlyAverages: {},
        dailyAverages: {},
        dataPoints: [],
      }
    }

    // Compute hourly averages
    const hourlyGroups: Record<number, number[]> = {}
    const dailyGroups: Record<number, number[]> = {}

    for (const s of filtered) {
      const hour = s.timestamp.getHours()
      const day = s.timestamp.getDay()

      if (!hourlyGroups[hour]) hourlyGroups[hour] = []
      if (!dailyGroups[day]) dailyGroups[day] = []

      hourlyGroups[hour].push(s.focusQuality)
      dailyGroups[day].push(s.focusQuality)
    }

    const hourlyAverages: Record<number, number> = {}
    for (const [hour, values] of Object.entries(hourlyGroups)) {
      hourlyAverages[parseInt(hour)] = values.reduce((a, b) => a + b, 0) / values.length
    }

    const dailyAverages: Record<number, number> = {}
    for (const [day, values] of Object.entries(dailyGroups)) {
      dailyAverages[parseInt(day)] = values.reduce((a, b) => a + b, 0) / values.length
    }

    return {
      hourlyAverages,
      dailyAverages,
      dataPoints: filtered.map((s) => ({
        timestamp: s.timestamp,
        focusQuality: s.focusQuality,
        hour: s.timestamp.getHours(),
        day: s.timestamp.getDay(),
      })),
    }
  }

  /**
   * Get today's snapshots
   */
  function getTodaySnapshots(): EnergySnapshot[] {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return snapshots.filter((s) => s.timestamp >= today)
  }

  /**
   * Get this week's snapshots
   */
  function getWeekSnapshots(): EnergySnapshot[] {
    const startOfWeek = new Date()
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())
    startOfWeek.setHours(0, 0, 0, 0)
    return snapshots.filter((s) => s.timestamp >= startOfWeek)
  }

  /**
   * Get average focus quality for a period
   */
  function getAverageFocusQuality(snapshotList?: EnergySnapshot[]): number {
    const list = snapshotList ?? snapshots
    if (list.length === 0) return 0
    return list.reduce((sum, s) => sum + s.focusQuality, 0) / list.length
  }

  /**
   * Get focus quality trend (improving, declining, stable)
   */
  function getFocusQualityTrend(): 'improving' | 'declining' | 'stable' {
    if (snapshots.length < 5) return 'stable'

    const recent = snapshots.slice(0, 5)
    const previous = snapshots.slice(5, 10)

    if (previous.length < 5) return 'stable'

    const recentAvg = getAverageFocusQuality(recent)
    const previousAvg = getAverageFocusQuality(previous)

    const diff = recentAvg - previousAvg
    if (diff > 0.5) return 'improving'
    if (diff < -0.5) return 'declining'
    return 'stable'
  }

  /**
   * Get total context switches for a period
   */
  function getTotalContextSwitches(snapshotList?: EnergySnapshot[]): number {
    const list = snapshotList ?? snapshots
    return list.reduce((sum, s) => sum + s.contextSwitches, 0)
  }

  /**
   * Get snapshots by work type
   */
  function getSnapshotsByWorkType(workType: EnergySnapshot['typeOfWork']): EnergySnapshot[] {
    return snapshots.filter((s) => s.typeOfWork === workType)
  }

  /**
   * Get work type distribution (percentage)
   */
  function getWorkTypeDistribution(): Record<string, number> {
    if (snapshots.length === 0) return {}

    const counts: Record<string, number> = {}
    for (const s of snapshots) {
      counts[s.typeOfWork] = (counts[s.typeOfWork] || 0) + 1
    }

    const distribution: Record<string, number> = {}
    for (const [type, count] of Object.entries(counts)) {
      distribution[type] = (count / snapshots.length) * 100
    }

    return distribution
  }

  /**
   * Get best focus hours (top 3 hours by average focus quality)
   */
  async function getBestFocusHours(): Promise<{ hour: number; averageQuality: number }[]> {
    if (!userId) return []

    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - 14)

    const heatmap = await getHeatmapData(startDate, endDate)
    if (!heatmap) return []

    const hourlyAverages = Object.entries(heatmap.hourlyAverages)
      .map(([hour, quality]) => ({
        hour: parseInt(hour),
        averageQuality: quality,
      }))
      .sort((a, b) => b.averageQuality - a.averageQuality)
      .slice(0, 3)

    return hourlyAverages
  }

  /**
   * Get best focus days (top 3 days by average focus quality)
   */
  async function getBestFocusDays(): Promise<{ day: string; averageQuality: number }[]> {
    if (!userId) return []

    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - 28)

    const heatmap = await getHeatmapData(startDate, endDate)
    if (!heatmap) return []

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

    const dailyAverages = Object.entries(heatmap.dailyAverages)
      .map(([day, quality]) => ({
        day: dayNames[parseInt(day)],
        averageQuality: quality,
      }))
      .sort((a, b) => b.averageQuality - a.averageQuality)
      .slice(0, 3)

    return dailyAverages
  }

  /**
   * Get focus quality color
   */
  function getFocusQualityColor(quality: FocusQuality): string {
    if (quality >= 4) return 'text-green-400'
    if (quality >= 3) return 'text-yellow-400'
    if (quality >= 2) return 'text-orange-400'
    return 'text-red-400'
  }

  /**
   * Get focus quality label
   */
  function getFocusQualityLabel(quality: FocusQuality): string {
    switch (quality) {
      case 5:
        return 'Excellent'
      case 4:
        return 'Good'
      case 3:
        return 'Average'
      case 2:
        return 'Poor'
      case 1:
        return 'Very Poor'
    }
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
      queryClient.invalidateQueries({ queryKey: assistantKeys.energySnapshotList(userId) })
    }
  }

  return {
    // State
    snapshots,
    loading,
    error,

    // Operations
    logSnapshot,
    getSnapshots,
    getHeatmapData,

    // Filters
    getTodaySnapshots,
    getWeekSnapshots,
    getSnapshotsByWorkType,

    // Analytics
    getAverageFocusQuality,
    getFocusQualityTrend,
    getTotalContextSwitches,
    getWorkTypeDistribution,
    getBestFocusHours,
    getBestFocusDays,

    // Utilities
    getFocusQualityColor,
    getFocusQualityLabel,
    clearError,
    refresh,

    // Server status
    isServerMode: !useFallback,
  }
}
