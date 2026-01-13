import { useState, useEffect } from 'react'
import type { BadgeProgress, BadgeType, BadgeRarity } from '@/lib/assistant/types'
import { BADGE_DEFINITIONS, getBadgeRarityColor } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'

/**
 * Hook to compute progress toward badges
 */
export function useBadgeProgress(userId: string | null) {
  const [progress, setProgress] = useState<BadgeProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load badge progress on mount
  useEffect(() => {
    if (!userId) {
      setProgress([])
      setLoading(false)
      return
    }

    const currentUserId = userId
    let mounted = true

    async function load() {
      setLoading(true)
      try {
        await initializeAssistantStorage()
        const adapter = getAssistantStorageAdapter()
        const data = await adapter.getBadgeProgress(currentUserId)
        if (mounted) {
          setProgress(data)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load badge progress')
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
   * Refresh badge progress
   */
  async function refresh(): Promise<void> {
    if (!userId) return

    setLoading(true)
    try {
      const adapter = getAssistantStorageAdapter()
      const data = await adapter.getBadgeProgress(userId)
      setProgress(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh badge progress')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Get progress for a specific badge
   */
  function getProgressForBadge(badgeType: BadgeType): BadgeProgress | undefined {
    return progress.find((p) => p.badgeType === badgeType)
  }

  /**
   * Get badges close to completion (>= 75%)
   */
  function getAlmostCompleteBadges(): BadgeProgress[] {
    return progress.filter((p) => p.percentComplete >= 75)
  }

  /**
   * Get badges in progress (25-75%)
   */
  function getInProgressBadges(): BadgeProgress[] {
    return progress.filter((p) => p.percentComplete >= 25 && p.percentComplete < 75)
  }

  /**
   * Get badges not started (<25%)
   */
  function getNotStartedBadges(): BadgeProgress[] {
    return progress.filter((p) => p.percentComplete < 25)
  }

  /**
   * Get badges by rarity
   */
  function getBadgesByRarity(rarity: BadgeRarity): BadgeProgress[] {
    return progress.filter((p) => p.rarity === rarity)
  }

  /**
   * Get next achievable badge (closest to completion)
   */
  function getNextAchievableBadge(): BadgeProgress | null {
    if (progress.length === 0) return null
    // Already sorted by percent complete descending
    return progress[0]
  }

  /**
   * Get top N badges to focus on
   */
  function getTopBadgesToFocus(n = 3): BadgeProgress[] {
    return progress.slice(0, n)
  }

  /**
   * Get badge icon from definitions
   */
  function getBadgeIcon(badgeType: BadgeType): string {
    const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeType)
    return definition?.icon ?? 'Award'
  }

  /**
   * Get badge rarity color
   */
  function getRarityColor(rarity: BadgeRarity): string {
    return getBadgeRarityColor(rarity)
  }

  /**
   * Format progress text
   */
  function formatProgressText(badgeProgress: BadgeProgress): string {
    const { current, target } = badgeProgress

    // Format based on badge type
    const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeProgress.badgeType)
    if (!definition) return `${current}/${target}`

    switch (definition.requirement.type) {
      case 'task-count':
        return `${current}/${target} tasks`
      case 'streak-days':
        return `${current}/${target} days`
      case 'focus-time':
        const currentHours = Math.floor(current / 60)
        const targetHours = Math.floor(target / 60)
        return `${currentHours}/${targetHours} hours`
      case 'decision-count':
        return `${current}/${target} decisions`
      case 'communication-count':
        return `${current}/${target} entries`
      default:
        return `${current}/${target}`
    }
  }

  /**
   * Get remaining amount text
   */
  function getRemainingText(badgeProgress: BadgeProgress): string {
    const { current, target } = badgeProgress
    const remaining = target - current

    if (remaining <= 0) return 'Ready to claim!'

    const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeProgress.badgeType)
    if (!definition) return `${remaining} more`

    switch (definition.requirement.type) {
      case 'task-count':
        return `${remaining} more task${remaining === 1 ? '' : 's'}`
      case 'streak-days':
        return `${remaining} more day${remaining === 1 ? '' : 's'}`
      case 'focus-time':
        const hours = Math.ceil(remaining / 60)
        return `${hours} more hour${hours === 1 ? '' : 's'}`
      case 'decision-count':
        return `${remaining} more decision${remaining === 1 ? '' : 's'}`
      case 'communication-count':
        return `${remaining} more entr${remaining === 1 ? 'y' : 'ies'}`
      default:
        return `${remaining} more`
    }
  }

  /**
   * Get rarity label
   */
  function getRarityLabel(rarity: BadgeRarity): string {
    switch (rarity) {
      case 'common':
        return 'Common'
      case 'uncommon':
        return 'Uncommon'
      case 'rare':
        return 'Rare'
      case 'legendary':
        return 'Legendary'
    }
  }

  /**
   * Get overall badge completion stats
   */
  function getCompletionStats(): {
    totalBadges: number
    earnedBadges: number
    inProgressCount: number
    averageProgress: number
  } {
    const totalBadges = BADGE_DEFINITIONS.length
    const earnedBadges = totalBadges - progress.length
    const inProgressCount = progress.filter((p) => p.percentComplete > 0).length
    const averageProgress =
      progress.length > 0
        ? progress.reduce((sum, p) => sum + p.percentComplete, 0) / progress.length
        : 0

    return {
      totalBadges,
      earnedBadges,
      inProgressCount,
      averageProgress: Math.round(averageProgress),
    }
  }

  /**
   * Get badges grouped by rarity
   */
  function getBadgesGroupedByRarity(): Record<BadgeRarity, BadgeProgress[]> {
    return {
      common: getBadgesByRarity('common'),
      uncommon: getBadgesByRarity('uncommon'),
      rare: getBadgesByRarity('rare'),
      legendary: getBadgesByRarity('legendary'),
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
    progress,
    loading,
    error,

    // Operations
    refresh,
    getProgressForBadge,

    // Filters
    getAlmostCompleteBadges,
    getInProgressBadges,
    getNotStartedBadges,
    getBadgesByRarity,
    getNextAchievableBadge,
    getTopBadgesToFocus,
    getBadgesGroupedByRarity,

    // Analytics
    getCompletionStats,

    // Utilities
    getBadgeIcon,
    getRarityColor,
    getRarityLabel,
    formatProgressText,
    getRemainingText,
    clearError,
  }
}
