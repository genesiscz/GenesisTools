/**
 * Celebrations Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Celebration, CelebrationTier, CompletionType } from '@/lib/assistant/types'
import { getCelebrationTierInfo, generateCelebrationId } from '@/lib/assistant/types'
import {
  getAssistantStorageAdapter,
  initializeAssistantStorage,
} from '@/lib/assistant/lib/storage'
import {
  useAssistantCelebrationsQuery,
  useCreateAssistantCelebrationMutation,
  useMarkAssistantCelebrationShownMutation,
  useDismissAssistantCelebrationMutation,
  assistantKeys,
} from './useAssistantQueries'

/**
 * Hook to manage celebrations and determine celebration tiers
 * Server-first with localStorage fallback
 */
export function useCelebrations(userId: string | null) {
  const queryClient = useQueryClient()
  const [fallbackMode, setFallbackMode] = useState(false)
  const [fallbackCelebrations, setFallbackCelebrations] = useState<Celebration[]>([])
  const [activeCelebration, setActiveCelebration] = useState<Celebration | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoShowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Server queries - only fetch unshown celebrations
  const celebrationsQuery = useAssistantCelebrationsQuery(userId, true)

  // Server mutations
  const createMutation = useCreateAssistantCelebrationMutation()
  const markShownMutation = useMarkAssistantCelebrationShownMutation()
  const dismissMutation = useDismissAssistantCelebrationMutation()

  // Determine if we should use fallback mode
  const useFallback = fallbackMode || (celebrationsQuery.isError && !celebrationsQuery.data)

  // Initialize localStorage fallback if server fails
  useEffect(() => {
    if (!userId) return

    if (celebrationsQuery.isError && !fallbackMode) {
      const currentUserId = userId

      async function loadFallback() {
        try {
          const adapter = await initializeAssistantStorage()
          const data = await adapter.getPendingCelebrations(currentUserId)
          setFallbackMode(true)
          setFallbackCelebrations(data)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load fallback')
        }
      }

      loadFallback()
    }
  }, [userId, celebrationsQuery.isError, fallbackMode])

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autoShowTimeoutRef.current) {
        clearTimeout(autoShowTimeoutRef.current)
        autoShowTimeoutRef.current = null
      }
    }
  }, [])

  // Convert server celebrations to app Celebration type
  const pendingCelebrations: Celebration[] = useMemo(() => {
    if (useFallback) return fallbackCelebrations.filter((c) => !c.shownAt && !c.dismissed)

    return (celebrationsQuery.data ?? []).map((c) => ({
      id: c.id,
      userId: c.userId,
      tier: c.tier as CelebrationTier,
      title: c.title,
      message: c.message,
      triggerType: c.triggerType,
      triggerId: c.triggerId ?? undefined,
      shownAt: c.shownAt ? new Date(c.shownAt) : undefined,
      dismissed: c.dismissed === 1,
      createdAt: new Date(c.createdAt),
    }))
  }, [useFallback, fallbackCelebrations, celebrationsQuery.data])

  // Loading state
  const loading = celebrationsQuery.isLoading

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

    const now = new Date()
    const celebrationId = generateCelebrationId()

    if (useFallback) {
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
        setFallbackCelebrations((prev) => [celebration, ...prev])
        return celebration
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create celebration')
        return null
      }
    }

    try {
      const result = await createMutation.mutateAsync({
        id: celebrationId,
        userId,
        tier,
        title,
        message,
        triggerType,
        triggerId: triggerId ?? null,
        shownAt: null,
        dismissed: 0,
        createdAt: now.toISOString(),
      })

      if (!result) throw new Error('Failed to create celebration')

      return {
        id: result.id,
        userId,
        tier,
        title,
        message,
        triggerType,
        triggerId,
        shownAt: undefined,
        dismissed: false,
        createdAt: now,
      }
    } catch (err) {
      // Fall back to localStorage on error
      try {
        const adapter = await initializeAssistantStorage()
        const celebration = await adapter.createCelebration(
          userId,
          tier,
          title,
          message,
          triggerType,
          triggerId
        )
        setFallbackCelebrations((prev) => [celebration, ...prev])
        return celebration
      } catch {
        setError(err instanceof Error ? err.message : 'Failed to create celebration')
        return null
      }
    }
  }

  /**
   * Show the next pending celebration
   */
  async function showNextCelebration(): Promise<Celebration | null> {
    const pending = pendingCelebrations[0]
    if (!pending || !userId) return null

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        const shown = await adapter.markCelebrationShown(pending.id)

        setActiveCelebration(shown)
        setFallbackCelebrations((prev) =>
          prev.map((c) => (c.id === pending.id ? shown : c))
        )

        // Auto-dismiss after duration
        const tierInfo = getCelebrationTierInfo(shown.tier)
        autoShowTimeoutRef.current = setTimeout(() => {
          dismissActiveCelebration()
        }, tierInfo.duration)

        return shown
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to show celebration')
        return null
      }
    }

    try {
      await markShownMutation.mutateAsync({ id: pending.id, userId })

      const shown: Celebration = {
        ...pending,
        shownAt: new Date(),
      }

      setActiveCelebration(shown)

      // Auto-dismiss after duration
      const tierInfo = getCelebrationTierInfo(shown.tier)
      autoShowTimeoutRef.current = setTimeout(() => {
        dismissActiveCelebration()
      }, tierInfo.duration)

      return shown
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to show celebration')
      return null
    }
  }

  /**
   * Dismiss the active celebration
   */
  async function dismissActiveCelebration(): Promise<void> {
    const active = activeCelebration
    if (!active || !userId) return

    if (autoShowTimeoutRef.current) {
      clearTimeout(autoShowTimeoutRef.current)
      autoShowTimeoutRef.current = null
    }

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        await adapter.dismissCelebration(active.id)
      } catch {
        // Ignore errors, just clear locally
      }
      setFallbackCelebrations((prev) =>
        prev.map((c) => (c.id === active.id ? { ...c, dismissed: true } : c))
      )
    } else {
      try {
        await dismissMutation.mutateAsync({ id: active.id, userId })
      } catch {
        // Ignore errors, just clear locally
      }
    }

    setActiveCelebration(null)
  }

  /**
   * Determine what tier celebration to show for a completion
   */
  async function determineTier(completionType: CompletionType): Promise<CelebrationTier> {
    if (!userId) return 'micro'

    try {
      const adapter = useFallback
        ? getAssistantStorageAdapter()
        : await initializeAssistantStorage()
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
      full: ['Incredible!', "You're on fire!", 'Milestone reached!'],
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
    return pendingCelebrations.length > 0
  }

  /**
   * Get count of pending celebrations
   */
  function getPendingCount(): number {
    return pendingCelebrations.length
  }

  /**
   * Check if celebration is currently showing
   */
  function isShowingCelebration(): boolean {
    return activeCelebration !== null
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
    setError(null)
  }

  /**
   * Manual refresh
   */
  function refresh() {
    if (userId) {
      queryClient.invalidateQueries({ queryKey: assistantKeys.celebrationList(userId) })
    }
  }

  return {
    // State
    pendingCelebrations,
    activeCelebration,
    loading,
    error,

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
    refresh,

    // Server status
    isServerMode: !useFallback,
  }
}
