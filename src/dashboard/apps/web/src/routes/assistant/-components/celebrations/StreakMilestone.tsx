/**
 * StreakMilestone - Celebration for streak achievements
 *
 * Displays appropriate tier celebration based on streak milestone:
 * - 3 days: Micro toast
 * - 5 days: Badge notification
 * - 7+ days: Full celebration
 */

import { MicroCelebration } from './MicroCelebration'
import { BadgeCelebration } from './BadgeCelebration'
import type { MicroCelebrationData, BadgeCelebrationData } from './types'
import { CELEBRATION_MESSAGES } from './types'

interface StreakMilestoneProps {
  streakDays: number
  onDismiss: () => void
  particlesEnabled?: boolean
}

/**
 * Determine celebration tier based on streak length
 */
function getStreakTier(days: number): 'micro' | 'badge' | 'full' {
  if (days >= 7) return 'full'
  if (days >= 5) return 'badge'
  return 'micro'
}

/**
 * Get streak message
 */
function getStreakMessage(days: number): string {
  const messages = CELEBRATION_MESSAGES.streak
  if (days in messages) {
    return messages[days as keyof typeof messages]
  }
  return `${days}-day streak! Keep it going!`
}

/**
 * Get streak title
 */
function getStreakTitle(days: number): string {
  if (days >= 30) return 'Monthly Master!'
  if (days >= 14) return 'Two Weeks Strong!'
  if (days >= 7) return 'One Week Strong!'
  if (days >= 5) return 'Building Momentum!'
  if (days >= 3) return 'Warming Up!'
  return 'Streak Started!'
}

export function StreakMilestone({
  streakDays,
  onDismiss,
  particlesEnabled = true,
}: StreakMilestoneProps) {
  const tier = getStreakTier(streakDays)

  // Tier 1: Micro toast for small streaks
  if (tier === 'micro') {
    const celebration: MicroCelebrationData = {
      id: `streak_${Date.now()}`,
      tier: 'micro',
      title: getStreakTitle(streakDays),
      message: getStreakMessage(streakDays),
      trigger: 'streak-milestone',
      icon: 'flame',
      accent: 'amber',
    }

    return <MicroCelebration celebration={celebration} onDismiss={onDismiss} />
  }

  // Tier 2/3: Badge celebration for significant streaks
  // Note: Tier 3 uses the existing CelebrationModal, so we show badge for 5-6 days
  const celebration: BadgeCelebrationData = {
    id: `streak_${Date.now()}`,
    tier: 'badge',
    title: getStreakTitle(streakDays),
    message: getStreakMessage(streakDays),
    trigger: 'streak-milestone',
    streakDays,
    badgeRarity: streakDays >= 7 ? 'rare' : 'uncommon',
  }

  return (
    <BadgeCelebration
      celebration={celebration}
      onDismiss={onDismiss}
      particlesEnabled={particlesEnabled}
    />
  )
}

/**
 * Create streak milestone celebration data
 */
export function createStreakMilestoneCelebration(
  streakDays: number
): MicroCelebrationData | BadgeCelebrationData {
  const tier = getStreakTier(streakDays)

  if (tier === 'micro') {
    return {
      id: `streak_${Date.now()}`,
      tier: 'micro',
      title: getStreakTitle(streakDays),
      message: getStreakMessage(streakDays),
      trigger: 'streak-milestone',
      icon: 'flame',
      accent: 'amber',
    }
  }

  return {
    id: `streak_${Date.now()}`,
    tier: 'badge',
    title: getStreakTitle(streakDays),
    message: getStreakMessage(streakDays),
    trigger: 'streak-milestone',
    streakDays,
    badgeRarity: streakDays >= 7 ? 'rare' : 'uncommon',
  }
}

/**
 * Check if streak is at a milestone
 */
export function isStreakMilestone(days: number): boolean {
  const milestones = [1, 3, 5, 7, 14, 30, 60, 100]
  return milestones.includes(days)
}
