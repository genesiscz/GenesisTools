/**
 * CelebrationManager - Orchestrates celebration tiers
 *
 * This component manages the celebration queue and decides which tier to display.
 * It integrates with the useCelebrations hook and handles the lifecycle of celebrations.
 *
 * Celebration Flow:
 * 1. Event triggers celebration (task complete, streak, badge, focus session)
 * 2. CelebrationManager determines appropriate tier
 * 3. Displays celebration in queue order (one at a time for tier 2-3, stacked for tier 1)
 */

import { useState, useEffect, createContext, useContext, type ReactNode } from 'react'
import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { MicroCelebration } from './MicroCelebration'
import { BadgeCelebration } from './BadgeCelebration'
import { CelebrationModal } from '@/lib/assistant/components/CelebrationModal'
import type {
  CelebrationData,
  CelebrationSettings,
  CelebrationMode,
  MicroCelebrationData,
  BadgeCelebrationData,
  FullCelebrationData,
} from './types'
import { DEFAULT_CELEBRATION_SETTINGS, getRandomMessage, CELEBRATION_MESSAGES } from './types'
import { isStreakMilestone } from './StreakMilestone'
import type { Task, Badge, Streak, UrgencyLevel } from '@/lib/assistant/types'

// ============================================
// Store
// ============================================

interface CelebrationManagerState {
  queue: CelebrationData[]
  settings: CelebrationSettings
  // Track current celebrations
  activeMicroCelebrations: MicroCelebrationData[]
  activeBadgeCelebration: BadgeCelebrationData | null
  activeFullCelebration: FullCelebrationData | null
  // Full celebration modal data
  fullModalData: {
    task: Task | null
    newBadges: Badge[]
    streak: Streak | null
    totalCompleted: number
  } | null
}

const SETTINGS_STORAGE_KEY = 'assistant_celebration_settings'

function loadSettings(): CelebrationSettings {
  if (typeof window === 'undefined') return DEFAULT_CELEBRATION_SETTINGS
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (stored) {
      return { ...DEFAULT_CELEBRATION_SETTINGS, ...JSON.parse(stored) }
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_CELEBRATION_SETTINGS
}

function saveSettings(settings: CelebrationSettings): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage errors
  }
}

export const celebrationManagerStore = new Store<CelebrationManagerState>({
  queue: [],
  settings: loadSettings(),
  activeMicroCelebrations: [],
  activeBadgeCelebration: null,
  activeFullCelebration: null,
  fullModalData: null,
})

// ============================================
// Context
// ============================================

interface CelebrationContextValue {
  // Trigger celebrations
  celebrateTaskCompletion: (
    task: Task,
    streak: Streak | null,
    newBadges: Badge[],
    totalCompleted: number
  ) => void
  celebrateFocusSession: (minutes?: number) => void
  celebrateStreakMilestone: (streakDays: number) => void
  celebrateBadgeEarned: (badge: Badge) => void
  celebrateDailyGoal: (tasksToday: number) => void

  // Settings
  settings: CelebrationSettings
  updateSettings: (updates: Partial<CelebrationSettings>) => void
  setMode: (mode: CelebrationMode) => void
}

const CelebrationContext = createContext<CelebrationContextValue | null>(null)

export function useCelebrationManager() {
  const context = useContext(CelebrationContext)
  if (!context) {
    throw new Error('useCelebrationManager must be used within CelebrationManagerProvider')
  }
  return context
}

// ============================================
// Provider Component
// ============================================

interface CelebrationManagerProviderProps {
  children: ReactNode
}

export function CelebrationManagerProvider({ children }: CelebrationManagerProviderProps) {
  const state = useStore(celebrationManagerStore)

  // Dismiss handlers
  function dismissMicroCelebration(id: string) {
    celebrationManagerStore.setState((s) => ({
      ...s,
      activeMicroCelebrations: s.activeMicroCelebrations.filter((c) => c.id !== id),
    }))
  }

  function dismissBadgeCelebration() {
    celebrationManagerStore.setState((s) => ({
      ...s,
      activeBadgeCelebration: null,
    }))
  }

  function dismissFullCelebration() {
    celebrationManagerStore.setState((s) => ({
      ...s,
      activeFullCelebration: null,
      fullModalData: null,
    }))
  }

  // Celebration triggers
  function celebrateTaskCompletion(
    task: Task,
    streak: Streak | null,
    newBadges: Badge[],
    totalCompleted: number
  ) {
    const { settings } = celebrationManagerStore.state
    if (settings.mode === 'silent') return

    // Determine tier based on task urgency and achievements
    const shouldShowFull =
      task.urgencyLevel === 'critical' ||
      (streak && streak.currentStreakDays >= 7 && isStreakMilestone(streak.currentStreakDays)) ||
      newBadges.some((b) => b.rarity === 'rare' || b.rarity === 'legendary')

    const shouldShowBadge =
      !shouldShowFull &&
      (newBadges.length > 0 ||
        (streak && streak.currentStreakDays >= 5 && isStreakMilestone(streak.currentStreakDays)) ||
        totalCompleted % 10 === 0)

    // Full celebration (Tier 3)
    if (shouldShowFull) {
      celebrationManagerStore.setState((s) => ({
        ...s,
        fullModalData: { task, newBadges, streak, totalCompleted },
        activeFullCelebration: {
          id: `full_${Date.now()}`,
          tier: 'full',
          title: 'Achievement Unlocked!',
          message: `Completed: ${task.title}`,
          trigger: 'task-complete',
          taskTitle: task.title,
        },
      }))
      return
    }

    // Badge celebration (Tier 2)
    if (shouldShowBadge && settings.mode === 'full-party') {
      const badgeName = newBadges[0]?.displayName
      const celebration: BadgeCelebrationData = {
        id: `badge_${Date.now()}`,
        tier: 'badge',
        title: badgeName ? 'Badge Earned!' : 'Great Progress!',
        message: badgeName
          ? `You unlocked: ${badgeName}`
          : `${totalCompleted} tasks completed!`,
        trigger: 'task-complete',
        badgeName,
        badgeRarity: newBadges[0]?.rarity ?? 'uncommon',
        tasksCompleted: totalCompleted,
      }

      celebrationManagerStore.setState((s) => ({
        ...s,
        activeBadgeCelebration: celebration,
      }))
      return
    }

    // Micro celebration (Tier 1)
    const messages = CELEBRATION_MESSAGES.taskComplete[task.urgencyLevel as UrgencyLevel]
    const celebration: MicroCelebrationData = {
      id: `micro_${Date.now()}`,
      tier: 'micro',
      title: getRandomMessage(messages),
      message: `Completed: ${task.title}`,
      trigger: 'task-complete',
      icon: 'check',
      accent:
        task.urgencyLevel === 'critical'
          ? 'amber'
          : task.urgencyLevel === 'important'
            ? 'purple'
            : 'emerald',
    }

    celebrationManagerStore.setState((s) => ({
      ...s,
      activeMicroCelebrations: [...s.activeMicroCelebrations, celebration].slice(-3), // Max 3 toasts
    }))
  }

  function celebrateFocusSession(minutes: number = 25) {
    const { settings } = celebrationManagerStore.state
    if (settings.mode === 'silent') return

    const celebration: MicroCelebrationData = {
      id: `focus_${Date.now()}`,
      tier: 'micro',
      title: 'Focus Complete!',
      message:
        minutes === 25
          ? getRandomMessage(CELEBRATION_MESSAGES.focusSession)
          : `${minutes} minutes of focused work. Great job!`,
      trigger: 'focus-session',
      icon: 'focus',
      accent: 'purple',
    }

    celebrationManagerStore.setState((s) => ({
      ...s,
      activeMicroCelebrations: [...s.activeMicroCelebrations, celebration].slice(-3),
    }))
  }

  function celebrateStreakMilestone(streakDays: number) {
    const { settings } = celebrationManagerStore.state
    if (settings.mode === 'silent') return
    if (!isStreakMilestone(streakDays)) return

    // Tier 3 for 7+ day milestones
    if (streakDays >= 7) {
      celebrationManagerStore.setState((s) => ({
        ...s,
        fullModalData: {
          task: null,
          newBadges: [],
          streak: {
            userId: '',
            currentStreakDays: streakDays,
            longestStreakDays: streakDays,
            lastTaskCompletionDate: new Date(),
          },
          totalCompleted: 0,
        },
        activeFullCelebration: {
          id: `streak_${Date.now()}`,
          tier: 'full',
          title:
            streakDays >= 30
              ? 'Monthly Master!'
              : streakDays >= 14
                ? 'Two Weeks Strong!'
                : 'One Week Strong!',
          message: `You've maintained a ${streakDays}-day streak!`,
          trigger: 'streak-milestone',
          streakDays,
        },
      }))
      return
    }

    // Tier 2 for 5-6 day streaks
    if (streakDays >= 5 && settings.mode === 'full-party') {
      const celebration: BadgeCelebrationData = {
        id: `streak_${Date.now()}`,
        tier: 'badge',
        title: 'Building Momentum!',
        message: CELEBRATION_MESSAGES.streak[5],
        trigger: 'streak-milestone',
        streakDays,
        badgeRarity: 'uncommon',
      }

      celebrationManagerStore.setState((s) => ({
        ...s,
        activeBadgeCelebration: celebration,
      }))
      return
    }

    // Tier 1 for smaller streaks
    const celebration: MicroCelebrationData = {
      id: `streak_${Date.now()}`,
      tier: 'micro',
      title: streakDays >= 3 ? 'Warming Up!' : 'Streak Started!',
      message:
        CELEBRATION_MESSAGES.streak[streakDays as keyof typeof CELEBRATION_MESSAGES.streak] ??
        `${streakDays}-day streak! Keep it going!`,
      trigger: 'streak-milestone',
      icon: 'flame',
      accent: 'amber',
    }

    celebrationManagerStore.setState((s) => ({
      ...s,
      activeMicroCelebrations: [...s.activeMicroCelebrations, celebration].slice(-3),
    }))
  }

  function celebrateBadgeEarned(badge: Badge) {
    const { settings } = celebrationManagerStore.state
    if (settings.mode === 'silent') return

    // Rare/legendary badges get full celebration
    if (badge.rarity === 'rare' || badge.rarity === 'legendary') {
      celebrationManagerStore.setState((s) => ({
        ...s,
        fullModalData: {
          task: null,
          newBadges: [badge],
          streak: null,
          totalCompleted: 0,
        },
        activeFullCelebration: {
          id: `badge_${Date.now()}`,
          tier: 'full',
          title: 'Badge Unlocked!',
          message: `You earned: ${badge.displayName}`,
          trigger: 'badge-earned',
          badgeName: badge.displayName,
          badgeRarity: badge.rarity,
        },
      }))
      return
    }

    // Other badges get badge celebration (Tier 2)
    if (settings.mode === 'full-party') {
      const celebration: BadgeCelebrationData = {
        id: `badge_${Date.now()}`,
        tier: 'badge',
        title: 'Badge Earned!',
        message: `You unlocked: ${badge.displayName}`,
        trigger: 'badge-earned',
        badgeName: badge.displayName,
        badgeRarity: badge.rarity,
      }

      celebrationManagerStore.setState((s) => ({
        ...s,
        activeBadgeCelebration: celebration,
      }))
    }
  }

  function celebrateDailyGoal(tasksToday: number) {
    const { settings } = celebrationManagerStore.state
    if (settings.mode === 'silent') return

    // 5+ tasks = speedrunner (Tier 2)
    if (tasksToday >= 5 && settings.mode === 'full-party') {
      const celebration: BadgeCelebrationData = {
        id: `speed_${Date.now()}`,
        tier: 'badge',
        title: 'Speedrunner!',
        message: getRandomMessage(CELEBRATION_MESSAGES.speedrunner),
        trigger: 'speedrunner',
        tasksCompleted: tasksToday,
        badgeRarity: 'uncommon',
      }

      celebrationManagerStore.setState((s) => ({
        ...s,
        activeBadgeCelebration: celebration,
      }))
      return
    }

    // 3 tasks = daily goal (Tier 1)
    if (tasksToday === 3) {
      const celebration: MicroCelebrationData = {
        id: `daily_${Date.now()}`,
        tier: 'micro',
        title: 'Daily Goal!',
        message: getRandomMessage(CELEBRATION_MESSAGES.dailyGoal),
        trigger: 'daily-goal',
        icon: 'star',
        accent: 'emerald',
      }

      celebrationManagerStore.setState((s) => ({
        ...s,
        activeMicroCelebrations: [...s.activeMicroCelebrations, celebration].slice(-3),
      }))
    }
  }

  // Settings management
  function updateSettings(updates: Partial<CelebrationSettings>) {
    celebrationManagerStore.setState((s) => {
      const newSettings = { ...s.settings, ...updates }
      saveSettings(newSettings)
      return { ...s, settings: newSettings }
    })
  }

  function setMode(mode: CelebrationMode) {
    updateSettings({ mode })
  }

  const contextValue: CelebrationContextValue = {
    celebrateTaskCompletion,
    celebrateFocusSession,
    celebrateStreakMilestone,
    celebrateBadgeEarned,
    celebrateDailyGoal,
    settings: state.settings,
    updateSettings,
    setMode,
  }

  return (
    <CelebrationContext.Provider value={contextValue}>
      {children}

      {/* Render active celebrations */}

      {/* Micro celebrations (bottom-right stack) */}
      {state.activeMicroCelebrations.map((celebration, index) => (
        <div
          key={celebration.id}
          style={{ transform: `translateY(-${index * 80}px)` }}
        >
          <MicroCelebration
            celebration={celebration}
            onDismiss={() => dismissMicroCelebration(celebration.id)}
          />
        </div>
      ))}

      {/* Badge celebration (center) */}
      {state.activeBadgeCelebration && (
        <BadgeCelebration
          celebration={state.activeBadgeCelebration}
          onDismiss={dismissBadgeCelebration}
          particlesEnabled={state.settings.particlesEnabled}
        />
      )}

      {/* Full celebration modal */}
      {state.fullModalData && (
        <CelebrationModal
          open={state.activeFullCelebration !== null}
          onOpenChange={(open) => {
            if (!open) dismissFullCelebration()
          }}
          task={state.fullModalData.task}
          newBadges={state.fullModalData.newBadges}
          streak={state.fullModalData.streak}
          totalCompleted={state.fullModalData.totalCompleted}
        />
      )}
    </CelebrationContext.Provider>
  )
}

// ============================================
// Settings Component
// ============================================

interface CelebrationSettingsProps {
  className?: string
}

export function CelebrationSettings({ className }: CelebrationSettingsProps) {
  const { settings, setMode, updateSettings } = useCelebrationManager()

  const modes: { value: CelebrationMode; label: string; description: string }[] = [
    { value: 'full-party', label: 'Full Party', description: 'All celebrations enabled' },
    { value: 'subtle', label: 'Subtle', description: 'Only significant achievements' },
    { value: 'silent', label: 'Silent', description: 'No celebrations' },
  ]

  return (
    <div className={className}>
      <h4 className="text-sm font-semibold mb-3">Celebration Mode</h4>
      <div className="space-y-2">
        {modes.map((mode) => (
          <button
            key={mode.value}
            onClick={() => setMode(mode.value)}
            className={`
              w-full p-3 rounded-lg text-left transition-colors
              ${
                settings.mode === mode.value
                  ? 'bg-purple-500/20 border-purple-500/50 border'
                  : 'bg-card border border-border hover:bg-accent'
              }
            `}
          >
            <div className="font-medium text-sm">{mode.label}</div>
            <div className="text-xs text-muted-foreground">{mode.description}</div>
          </button>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-border">
        <label className="flex items-center justify-between">
          <span className="text-sm">Particle effects</span>
          <input
            type="checkbox"
            checked={settings.particlesEnabled}
            onChange={(e) => updateSettings({ particlesEnabled: e.target.checked })}
            className="rounded"
          />
        </label>
      </div>
    </div>
  )
}
