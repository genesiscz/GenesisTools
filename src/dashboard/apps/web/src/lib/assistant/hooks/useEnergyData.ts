import { useState, useEffect } from 'react'
import type { EnergySnapshot, EnergySnapshotInput, FocusQuality } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'
import type {
  EnergyQueryOptions,
  EnergyHeatmapData,
} from '@/lib/assistant/lib/storage/types'

/**
 * Hook to manage energy snapshots and compute heatmap data
 */
export function useEnergyData(userId: string | null) {
  const [snapshots, setSnapshots] = useState<EnergySnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load snapshots on mount
  useEffect(() => {
    if (!userId) {
      setSnapshots([])
      setLoading(false)
      return
    }

    let mounted = true

    async function load() {
      setLoading(true)
      try {
        await initializeAssistantStorage()
        const adapter = getAssistantStorageAdapter()

        // Load last 30 days of snapshots by default
        const endDate = new Date()
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - 30)

        const data = await adapter.getEnergySnapshots(userId, { startDate, endDate })
        if (mounted) {
          setSnapshots(data)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load energy data')
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
   * Log a new energy snapshot
   */
  async function logSnapshot(input: EnergySnapshotInput): Promise<EnergySnapshot | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const snapshot = await adapter.logEnergySnapshot(input, userId)

      // Add to local state
      setSnapshots((prev) => [snapshot, ...prev])

      return snapshot
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log energy snapshot')
      return null
    }
  }

  /**
   * Get energy snapshots with filters
   */
  async function getSnapshots(options?: EnergyQueryOptions): Promise<EnergySnapshot[]> {
    if (!userId) return []

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getEnergySnapshots(userId, options)
    } catch {
      return []
    }
  }

  /**
   * Get heatmap data for visualization
   */
  async function getHeatmapData(startDate: Date, endDate: Date): Promise<EnergyHeatmapData | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getEnergyHeatmapData(userId, startDate, endDate)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get heatmap data')
      return null
    }
  }

  /**
   * Get today's snapshots
   */
  function getTodaySnapshots(): EnergySnapshot[] {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return snapshots.filter((s) => new Date(s.timestamp) >= today)
  }

  /**
   * Get this week's snapshots
   */
  function getWeekSnapshots(): EnergySnapshot[] {
    const startOfWeek = new Date()
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())
    startOfWeek.setHours(0, 0, 0, 0)
    return snapshots.filter((s) => new Date(s.timestamp) >= startOfWeek)
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

    // Compare recent 5 vs previous 5
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
    startDate.setDate(startDate.getDate() - 14) // Look at last 2 weeks

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
    startDate.setDate(startDate.getDate() - 28) // Look at last 4 weeks

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
  }
}
