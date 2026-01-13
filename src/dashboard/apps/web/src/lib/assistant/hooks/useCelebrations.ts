import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'
import type { Celebration, CelebrationTier, CompletionType } from '@/lib/assistant/types'
import { getCelebrationTierInfo } from '@/lib/assistant/types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '@/lib/assistant/lib/storage'

/**
 * Celebration store state
 */
interface CelebrationStoreState {
  pendingCelebrations: Celebration[]
  activeCelebration: Celebration | null
  loading: boolean
  error: string | null
  initialized: boolean
}

/**
 * Create the celebration store
 */
export const celebrationStore = new Store<CelebrationStoreState>({
  pendingCelebrations: [],
  activeCelebration: null,
  loading: false,
  error: null,
  initialized: false,
})

/**
 * Hook to manage celebrations and determine celebration tiers
 */
export function useCelebrations(userId: string | null) {
  const state = useStore(celebrationStore)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const autoShowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Initialize storage and subscribe to updates
  useEffect(() => {
    if (!userId) return

    const currentUserId = userId
    let mounted = true

    async function init() {
      celebrationStore.setState((s) => ({ ...s, loading: true }))

      try {
        const adapter = await initializeAssistantStorage()

        // Initial load
        const celebrations = await adapter.getPendingCelebrations(currentUserId)

        if (mounted) {
          celebrationStore.setState((s) => ({
            ...s,
            pendingCelebrations: celebrations,
            loading: false,
            initialized: true,
          }))
        }

        // Subscribe to updates
        unsubscribeRef.current = adapter.watchCelebrations(currentUserId, (updatedCelebrations) => {
          if (mounted) {
            celebrationStore.setState((s) => ({
              ...s,
              pendingCelebrations: updatedCelebrations.filter((c) => !c.shownAt && !c.dismissed),
            }))
          }
        })
      } catch (err) {
        if (mounted) {
          celebrationStore.setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to initialize celebrations',
            loading: false,
          }))
        }
      }
    }

    init()

    return () => {
      mounted = false
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      if (autoShowTimeoutRef.current) {
        clearTimeout(autoShowTimeoutRef.current)
        autoShowTimeoutRef.current = null
      }
    }
  }, [userId])

  /**
   * Create a celebration
   */
  async function createCelebration(
    tier: CelebrationTier,
    title: string,
    message: string,
    triggerType: string,
    triggerId?: string
  ): Promise<Celebration | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const celebration = await adapter.createCelebration(
        userId,
        tier,
        title,
        message,
        triggerType,
        triggerId
      )
      return celebration
    } catch (err) {
      celebrationStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to create celebration',
      }))
      return null
    }
  }

  /**
   * Show the next pending celebration
   */
  async function showNextCelebration(): Promise<Celebration | null> {
    const pending = state.pendingCelebrations[0]
    if (!pending) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const shown = await adapter.markCelebrationShown(pending.id)

      celebrationStore.setState((s) => ({
        ...s,
        activeCelebration: shown,
        pendingCelebrations: s.pendingCelebrations.filter((c) => c.id !== pending.id),
      }))

      // Auto-dismiss after duration
      const tierInfo = getCelebrationTierInfo(shown.tier)
      autoShowTimeoutRef.current = setTimeout(() => {
        dismissActiveCelebration()
      }, tierInfo.duration)

      return shown
    } catch (err) {
      celebrationStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to show celebration',
      }))
      return null
    }
  }

  /**
   * Dismiss the active celebration
   */
  async function dismissActiveCelebration(): Promise<void> {
    const active = state.activeCelebration
    if (!active) return

    if (autoShowTimeoutRef.current) {
      clearTimeout(autoShowTimeoutRef.current)
      autoShowTimeoutRef.current = null
    }

    try {
      const adapter = getAssistantStorageAdapter()
      await adapter.dismissCelebration(active.id)
    } catch {
      // Ignore errors, just clear locally
    }

    celebrationStore.setState((s) => ({
      ...s,
      activeCelebration: null,
    }))
  }

  /**
   * Determine what tier celebration to show for a completion
   */
  async function determineTier(completionType: CompletionType): Promise<CelebrationTier> {
    if (!userId) return 'micro'

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.determineCelebrationTier(userId, completionType)
    } catch {
      return 'micro'
    }
  }

  /**
   * Create celebration for task completion
   */
  async function celebrateTaskCompletion(
    taskId: string,
    taskTitle: string
  ): Promise<Celebration | null> {
    const tier = await determineTier('task-complete')

    const messages = {
      micro: ['Nice!', 'Done!', 'Got it!', 'Checked off!'],
      badge: ['Awesome work!', 'Great progress!', 'Keep it up!'],
      full: ['Incredible!', 'You\'re on fire!', 'Milestone reached!'],
    }

    const messageList = messages[tier]
    const message = messageList[Math.floor(Math.random() * messageList.length)]

    return createCelebration(tier, message, `Completed: ${taskTitle}`, 'task-complete', taskId)
  }

  /**
   * Create celebration for streak milestone
   */
  async function celebrateStreakMilestone(streakDays: number): Promise<Celebration | null> {
    const tier: CelebrationTier = streakDays >= 30 ? 'full' : streakDays >= 7 ? 'badge' : 'micro'

    const milestoneMessages: Record<number, string> = {
      3: 'Warming Up!',
      7: 'One Week Strong!',
      14: 'Two Weeks Unstoppable!',
      30: 'Monthly Master!',
      60: 'Two Months of Excellence!',
      100: 'Century of Consistency!',
    }

    const title = milestoneMessages[streakDays] ?? `${streakDays}-Day Streak!`
    const message = `You've completed tasks ${streakDays} days in a row!`

    return createCelebration(tier, title, message, 'streak-milestone')
  }

  /**
   * Create celebration for badge earned
   */
  async function celebrateBadgeEarned(
    badgeId: string,
    badgeName: string
  ): Promise<Celebration | null> {
    return createCelebration(
      'badge',
      'Badge Earned!',
      `You unlocked: ${badgeName}`,
      'badge-earned',
      badgeId
    )
  }

  /**
   * Check if there are pending celebrations
   */
  function hasPendingCelebrations(): boolean {
    return state.pendingCelebrations.length > 0
  }

  /**
   * Get count of pending celebrations
   */
  function getPendingCount(): number {
    return state.pendingCelebrations.length
  }

  /**
   * Check if celebration is currently showing
   */
  function isShowingCelebration(): boolean {
    return state.activeCelebration !== null
  }

  /**
   * Get celebration tier info
   */
  function getTierInfo(tier: CelebrationTier) {
    return getCelebrationTierInfo(tier)
  }

  /**
   * Clear error
   */
  function clearError() {
    celebrationStore.setState((s) => ({ ...s, error: null }))
  }

  return {
    // State
    pendingCelebrations: state.pendingCelebrations,
    activeCelebration: state.activeCelebration,
    loading: state.loading,
    error: state.error,
    initialized: state.initialized,

    // Operations
    createCelebration,
    showNextCelebration,
    dismissActiveCelebration,
    determineTier,

    // Specific celebrations
    celebrateTaskCompletion,
    celebrateStreakMilestone,
    celebrateBadgeEarned,

    // Checks
    hasPendingCelebrations,
    getPendingCount,
    isShowingCelebration,

    // Utilities
    getTierInfo,
    clearError,
  }
}
