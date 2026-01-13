import { useState, useEffect } from 'react'
import type { WeeklyReview, WeeklyReviewInput } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'

/**
 * Hook to generate and manage weekly reviews
 */
export function useWeeklyReview(userId: string | null) {
  const [reviews, setReviews] = useState<WeeklyReview[]>([])
  const [currentReview, setCurrentReview] = useState<WeeklyReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load reviews on mount
  useEffect(() => {
    if (!userId) {
      setReviews([])
      setCurrentReview(null)
      setLoading(false)
      return
    }

    let mounted = true

    async function load() {
      setLoading(true)
      try {
        await initializeAssistantStorage()
        const adapter = getAssistantStorageAdapter()

        // Load recent reviews
        const data = await adapter.getWeeklyReviews(userId, 10)

        // Check for current week review
        const current = await adapter.getCurrentWeekReview(userId)

        if (mounted) {
          setReviews(data)
          setCurrentReview(current)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load weekly reviews')
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
   * Generate a weekly review for a specific week
   */
  async function generateReview(input: WeeklyReviewInput): Promise<WeeklyReview | null> {
    if (!userId) return null

    setGenerating(true)
    try {
      const adapter = getAssistantStorageAdapter()
      const review = await adapter.generateWeeklyReview(input, userId)

      // Add to local state
      setReviews((prev) => [review, ...prev.filter((r) => r.id !== review.id)])

      // Update current review if it's this week
      const now = new Date()
      const startOfWeek = new Date(now)
      startOfWeek.setDate(now.getDate() - now.getDay())
      startOfWeek.setHours(0, 0, 0, 0)

      if (new Date(review.weekStart).getTime() === startOfWeek.getTime()) {
        setCurrentReview(review)
      }

      return review
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate weekly review')
      return null
    } finally {
      setGenerating(false)
    }
  }

  /**
   * Generate review for current week
   */
  async function generateCurrentWeekReview(): Promise<WeeklyReview | null> {
    const now = new Date()
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay())
    startOfWeek.setHours(0, 0, 0, 0)

    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(endOfWeek.getDate() + 6)
    endOfWeek.setHours(23, 59, 59, 999)

    return generateReview({
      weekStart: startOfWeek,
      weekEnd: endOfWeek,
    })
  }

  /**
   * Generate review for last week
   */
  async function generateLastWeekReview(): Promise<WeeklyReview | null> {
    const now = new Date()
    const startOfThisWeek = new Date(now)
    startOfThisWeek.setDate(now.getDate() - now.getDay())
    startOfThisWeek.setHours(0, 0, 0, 0)

    const startOfLastWeek = new Date(startOfThisWeek)
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7)

    const endOfLastWeek = new Date(startOfThisWeek)
    endOfLastWeek.setDate(endOfLastWeek.getDate() - 1)
    endOfLastWeek.setHours(23, 59, 59, 999)

    return generateReview({
      weekStart: startOfLastWeek,
      weekEnd: endOfLastWeek,
    })
  }

  /**
   * Get a review by ID
   */
  function getReview(id: string): WeeklyReview | undefined {
    return reviews.find((r) => r.id === id)
  }

  /**
   * Get review for a specific week
   */
  function getReviewForWeek(weekStart: Date): WeeklyReview | undefined {
    const weekStartTime = new Date(weekStart)
    weekStartTime.setHours(0, 0, 0, 0)

    return reviews.find((r) => {
      const reviewStart = new Date(r.weekStart)
      reviewStart.setHours(0, 0, 0, 0)
      return reviewStart.getTime() === weekStartTime.getTime()
    })
  }

  /**
   * Check if current week review exists
   */
  function hasCurrentWeekReview(): boolean {
    return currentReview !== null
  }

  /**
   * Get week-over-week comparison
   */
  function getWeekOverWeekComparison(): {
    tasksChange: number
    tasksChangePercent: number
    direction: 'up' | 'down' | 'same'
  } | null {
    if (!currentReview) return null

    const change = currentReview.tasksCompleted - currentReview.tasksCompletedLastWeek
    const percentChange =
      currentReview.tasksCompletedLastWeek > 0
        ? (change / currentReview.tasksCompletedLastWeek) * 100
        : currentReview.tasksCompleted > 0
          ? 100
          : 0

    return {
      tasksChange: change,
      tasksChangePercent: Math.round(percentChange),
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'same',
    }
  }

  /**
   * Get deadline hit rate
   */
  function getDeadlineHitRate(review?: WeeklyReview): number {
    const r = review ?? currentReview
    if (!r || r.deadlinesTotal === 0) return 0
    return (r.deadlinesHit / r.deadlinesTotal) * 100
  }

  /**
   * Get deep focus percentage
   */
  function getDeepFocusPercentage(review?: WeeklyReview): number {
    const r = review ?? currentReview
    if (!r || r.totalMinutes === 0) return 0
    return (r.deepFocusMinutes / r.totalMinutes) * 100
  }

  /**
   * Get meeting percentage
   */
  function getMeetingPercentage(review?: WeeklyReview): number {
    const r = review ?? currentReview
    if (!r || r.totalMinutes === 0) return 0
    return (r.meetingMinutes / r.totalMinutes) * 100
  }

  /**
   * Format week range
   */
  function formatWeekRange(review: WeeklyReview): string {
    const startDate = new Date(review.weekStart)
    const endDate = new Date(review.weekEnd)

    const startMonth = startDate.toLocaleString('default', { month: 'short' })
    const endMonth = endDate.toLocaleString('default', { month: 'short' })

    if (startMonth === endMonth) {
      return `${startMonth} ${startDate.getDate()}-${endDate.getDate()}`
    }
    return `${startMonth} ${startDate.getDate()} - ${endMonth} ${endDate.getDate()}`
  }

  /**
   * Get energy rating label
   */
  function getEnergyLabel(averageEnergy: number): string {
    if (averageEnergy >= 4) return 'Excellent'
    if (averageEnergy >= 3) return 'Good'
    if (averageEnergy >= 2) return 'Fair'
    return 'Low'
  }

  /**
   * Get energy rating color
   */
  function getEnergyColor(averageEnergy: number): string {
    if (averageEnergy >= 4) return 'text-green-400'
    if (averageEnergy >= 3) return 'text-yellow-400'
    if (averageEnergy >= 2) return 'text-orange-400'
    return 'text-red-400'
  }

  /**
   * Generate review summary text
   */
  function generateSummaryText(review?: WeeklyReview): string {
    const r = review ?? currentReview
    if (!r) return ''

    const lines: string[] = []

    // Productivity headline
    const comparison = getWeekOverWeekComparison()
    if (comparison) {
      if (comparison.direction === 'up') {
        lines.push(`Great week! You completed ${comparison.tasksChangePercent}% more tasks than last week.`)
      } else if (comparison.direction === 'down') {
        lines.push(
          `You completed ${Math.abs(comparison.tasksChangePercent)}% fewer tasks than last week.`
        )
      } else {
        lines.push('You maintained consistent productivity this week.')
      }
    }

    // Streak highlight
    if (r.streakDays > 0) {
      lines.push(`You're on a ${r.streakDays}-day completion streak!`)
    }

    // Badges
    if (r.badgesEarned.length > 0) {
      lines.push(`You earned ${r.badgesEarned.length} new badge${r.badgesEarned.length > 1 ? 's' : ''}!`)
    }

    // Deadlines
    const hitRate = getDeadlineHitRate(r)
    if (r.deadlinesTotal > 0) {
      lines.push(`Deadline hit rate: ${Math.round(hitRate)}% (${r.deadlinesHit}/${r.deadlinesTotal})`)
    }

    return lines.join(' ')
  }

  /**
   * Clear error
   */
  function clearError() {
    setError(null)
  }

  return {
    // State
    reviews,
    currentReview,
    loading,
    generating,
    error,

    // Operations
    generateReview,
    generateCurrentWeekReview,
    generateLastWeekReview,
    getReview,
    getReviewForWeek,

    // Checks
    hasCurrentWeekReview,

    // Analytics
    getWeekOverWeekComparison,
    getDeadlineHitRate,
    getDeepFocusPercentage,
    getMeetingPercentage,

    // Utilities
    formatWeekRange,
    getEnergyLabel,
    getEnergyColor,
    generateSummaryText,
    clearError,
  }
}
