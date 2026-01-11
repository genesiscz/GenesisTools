import { useState, useEffect } from 'react'
import type { Streak, Badge } from '../types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '../lib/storage'

/**
 * Hook to manage streak state and badge checking
 */
export function useStreak(userId: string | null) {
  const [streak, setStreak] = useState<Streak | null>(null)
  const [loading, setLoading] = useState(true)

  // Load streak on mount
  useEffect(() => {
    if (!userId) {
      setStreak(null)
      setLoading(false)
      return
    }

    async function loadStreak() {
      try {
        await initializeAssistantStorage()
        const adapter = getAssistantStorageAdapter()
        const currentStreak = await adapter.getStreak(userId)
        setStreak(currentStreak)
      } finally {
        setLoading(false)
      }
    }

    loadStreak()
  }, [userId])

  /**
   * Update streak after task completion
   * Returns new streak value
   */
  async function updateStreak(): Promise<Streak | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const newStreak = await adapter.updateStreak(userId)
      setStreak(newStreak)
      return newStreak
    } catch {
      return null
    }
  }

  /**
   * Check for newly earned badges after task completion
   * Automatically awards eligible badges and returns list
   */
  async function checkAndAwardBadges(): Promise<Badge[]> {
    if (!userId) return []

    try {
      const adapter = getAssistantStorageAdapter()
      const eligibleBadges = await adapter.checkBadgeEligibility(userId)
      const awardedBadges: Badge[] = []

      for (const badgeType of eligibleBadges) {
        const badge = await adapter.awardBadge(userId, badgeType)
        awardedBadges.push(badge)
      }

      return awardedBadges
    } catch {
      return []
    }
  }

  /**
   * Get streak motivation message
   */
  function getStreakMessage(): string | null {
    if (!streak) return null

    const days = streak.currentStreakDays

    if (days === 0) return null
    if (days === 1) return 'Start of a new streak!'
    if (days < 3) return 'Building momentum...'
    if (days < 7) return `${days}-day streak! Keep it up!`
    if (days < 14) return `${days}-day streak! You're on fire!`
    if (days < 30) return `${days}-day streak! Unstoppable!`
    return `${days}-day streak! LEGENDARY!`
  }

  /**
   * Check if streak is at risk (last completion was yesterday)
   */
  function isStreakAtRisk(): boolean {
    if (!streak || streak.currentStreakDays === 0) return false

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const lastCompletion = new Date(streak.lastTaskCompletionDate)
    const lastCompletionDay = new Date(
      lastCompletion.getFullYear(),
      lastCompletion.getMonth(),
      lastCompletion.getDate()
    )

    const daysDiff = Math.floor(
      (today.getTime() - lastCompletionDay.getTime()) / (1000 * 60 * 60 * 24)
    )

    // At risk if last completion was yesterday and no completion today
    return daysDiff >= 1
  }

  /**
   * Get streak milestone info (for celebration)
   */
  function getStreakMilestone(): { days: number; message: string } | null {
    if (!streak) return null

    const days = streak.currentStreakDays
    const milestones = [3, 7, 14, 30, 60, 100]

    for (const milestone of milestones) {
      if (days === milestone) {
        return {
          days: milestone,
          message:
            milestone === 3
              ? 'Warming Up!'
              : milestone === 7
                ? 'One Week Strong!'
                : milestone === 14
                  ? 'Two Weeks Unstoppable!'
                  : milestone === 30
                    ? 'Monthly Master!'
                    : milestone === 60
                      ? 'Two Months of Excellence!'
                      : 'Century of Consistency!',
        }
      }
    }

    return null
  }

  return {
    streak,
    loading,
    updateStreak,
    checkAndAwardBadges,
    getStreakMessage,
    isStreakAtRisk,
    getStreakMilestone,
  }
}
