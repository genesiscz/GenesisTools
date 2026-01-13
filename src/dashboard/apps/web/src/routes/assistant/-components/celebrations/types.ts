/**
 * Celebration system types
 */

import type { CelebrationTier, BadgeRarity } from '@/lib/assistant/types'

/**
 * Celebration mode preferences
 */
export type CelebrationMode = 'full-party' | 'subtle' | 'silent'

/**
 * Types of celebration triggers
 */
export type CelebrationTrigger =
  | 'focus-session'
  | 'task-complete'
  | 'streak-milestone'
  | 'badge-earned'
  | 'daily-goal'
  | 'speedrunner'

/**
 * Micro celebration (Tier 1) data
 */
export interface MicroCelebrationData {
  id: string
  tier: 'micro'
  title: string
  message: string
  trigger: CelebrationTrigger
  icon?: 'check' | 'focus' | 'flame' | 'star' | 'zap'
  accent?: 'emerald' | 'amber' | 'purple' | 'blue'
}

/**
 * Badge celebration (Tier 2) data
 */
export interface BadgeCelebrationData {
  id: string
  tier: 'badge'
  title: string
  message: string
  trigger: CelebrationTrigger
  badgeName?: string
  badgeRarity?: BadgeRarity
  streakDays?: number
  tasksCompleted?: number
}

/**
 * Full celebration (Tier 3) data
 */
export interface FullCelebrationData {
  id: string
  tier: 'full'
  title: string
  message: string
  trigger: CelebrationTrigger
  taskTitle?: string
  badgeName?: string
  badgeRarity?: BadgeRarity
  streakDays?: number
}

/**
 * Union type for all celebration data
 */
export type CelebrationData =
  | MicroCelebrationData
  | BadgeCelebrationData
  | FullCelebrationData

/**
 * Celebration queue item
 */
export interface QueuedCelebration {
  data: CelebrationData
  createdAt: Date
  shownAt?: Date
}

/**
 * Celebration settings
 */
export interface CelebrationSettings {
  mode: CelebrationMode
  soundEnabled: boolean
  particlesEnabled: boolean
}

/**
 * Default celebration settings
 */
export const DEFAULT_CELEBRATION_SETTINGS: CelebrationSettings = {
  mode: 'full-party',
  soundEnabled: false,
  particlesEnabled: true,
}

/**
 * Celebration duration by tier (milliseconds)
 */
export const CELEBRATION_DURATION: Record<CelebrationTier, number> = {
  micro: 3000,
  badge: 5000,
  full: 0, // User-dismissed
}

/**
 * Context-aware celebration messages
 */
export const CELEBRATION_MESSAGES = {
  focusSession: [
    'Nice focus! 25 minutes of deep work.',
    'Focus session complete! Great concentration.',
    'Deep work done! Your brain thanks you.',
  ],
  taskComplete: {
    'nice-to-have': ['Done!', 'Checked off!', 'Nice work!'],
    important: ['Great progress!', 'Moving forward!', 'One less thing to worry about!'],
    critical: ['CRITICAL DONE!', 'Crisis averted!', 'You\'re a hero!'],
  },
  streak: {
    3: 'Warming up! 3-day streak.',
    5: '5-day streak maintained!',
    7: 'One week strong! 7-day streak!',
    14: 'Two weeks unstoppable!',
    30: 'Monthly master! 30-day streak!',
  },
  dailyGoal: [
    'You\'re on a roll! 3 tasks today.',
    'Daily goal hit! Great momentum.',
    'Crushing it! Keep going.',
  ],
  speedrunner: [
    '5 tasks in one day! Speedrunner mode activated.',
    'Blazing through tasks! 5 completed today.',
  ],
  badgeEarned: (badgeName: string) => `Badge unlocked: ${badgeName}`,
} as const

/**
 * Get a random message from a message array
 */
export function getRandomMessage(messages: readonly string[]): string {
  return messages[Math.floor(Math.random() * messages.length)]
}
