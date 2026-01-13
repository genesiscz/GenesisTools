/**
 * Blockers Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TaskBlocker, TaskBlockerInput, TaskBlockerUpdate } from '@/lib/assistant/types'
import { generateBlockerId } from '@/lib/assistant/types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '@/lib/assistant/lib/storage'
import {
  useAssistantBlockersQuery,
  useCreateAssistantBlockerMutation,
  useUpdateAssistantBlockerMutation,
  useResolveAssistantBlockerMutation,
  assistantKeys,
} from './useAssistantQueries'

/**
 * Blockers store state for fallback mode
 */
interface BlockersStoreState {
  fallbackMode: boolean
  fallbackBlockers: TaskBlocker[]
  error: string | null
}

/**
 * Create the blockers store (for fallback state only)
 */
export const blockersStore = new Store<BlockersStoreState>({
  fallbackMode: false,
  fallbackBlockers: [],
  error: null,
})

/**
 * Hook to manage task blockers
 * Server-first with localStorage fallback
 */
export function useBlockers(userId: string | null) {
  const state = useStore(blockersStore)
  const queryClient = useQueryClient()

  // Server queries
  const blockersQuery = useAssistantBlockersQuery(userId)

  // Server mutations
  const createMutation = useCreateAssistantBlockerMutation()
  const updateMutation = useUpdateAssistantBlockerMutation()
  const resolveMutation = useResolveAssistantBlockerMutation()

  // Determine if we should use fallback mode
  const useFallback = state.fallbackMode || (blockersQuery.isError && !blockersQuery.data)

  // Initialize localStorage fallback if server fails
  useEffect(() => {
    if (!userId) return

    if (blockersQuery.isError && !state.fallbackMode) {
      const currentUserId = userId

      async function loadFallback() {
        try {
          const adapter = await initializeAssistantStorage()
          const blockers = await adapter.getBlockers(currentUserId)

          blockersStore.setState((s) => ({
            ...s,
            fallbackMode: true,
            fallbackBlockers: blockers,
          }))
        } catch (err) {
          blockersStore.setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to load fallback',
          }))
        }
      }

      loadFallback()
    }
  }, [userId, blockersQuery.isError, state.fallbackMode])

  // Convert server blockers to app TaskBlocker type
  const blockers: TaskBlocker[] = useMemo(() => {
    if (useFallback) return state.fallbackBlockers

    return (blockersQuery.data ?? []).map((b) => ({
      id: b.id,
      userId: b.userId,
      taskId: b.taskId,
      blockerReason: b.blockerReason,
      blockerOwner: b.blockerOwner ?? undefined,
      blockedSince: new Date(b.blockedSince),
      unblockedAt: b.unblockedAt ? new Date(b.unblockedAt) : undefined,
      reminderSet: b.reminderSet ? new Date(b.reminderSet) : undefined,
      createdAt: new Date(b.createdAt),
      updatedAt: new Date(b.updatedAt),
    }))
  }, [useFallback, state.fallbackBlockers, blockersQuery.data])

  // Loading state
  const loading = blockersQuery.isLoading
  const initialized = !loading && (blockersQuery.data !== undefined || useFallback)

  /**
   * Add a new blocker to a task
   */
  async function addBlocker(input: TaskBlockerInput): Promise<TaskBlocker | null> {
    if (!userId) return null

    const now = new Date()
    const blockerId = generateBlockerId()

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        return await adapter.createBlocker(input, userId)
      } catch (err) {
        blockersStore.setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : 'Failed to add blocker',
        }))
        return null
      }
    }

    try {
      const result = await createMutation.mutateAsync({
        id: blockerId,
        userId,
        taskId: input.taskId,
        blockerReason: input.blockerReason,
        blockerOwner: input.blockerOwner ?? null,
        blockedSince: now.toISOString(),
        unblockedAt: null,
        reminderSet: input.reminderSet?.toISOString() ?? null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      })

      if (!result) throw new Error('Failed to add blocker')

      return {
        id: result.id,
        userId,
        taskId: input.taskId,
        blockerReason: input.blockerReason,
        blockerOwner: input.blockerOwner,
        blockedSince: now,
        reminderSet: input.reminderSet,
        createdAt: now,
        updatedAt: now,
      }
    } catch (err) {
      // Fall back to localStorage on error
      try {
        const adapter = await initializeAssistantStorage()
        return await adapter.createBlocker(input, userId)
      } catch {
        blockersStore.setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : 'Failed to add blocker',
        }))
        return null
      }
    }
  }

  /**
   * Update an existing blocker
   */
  async function updateBlocker(id: string, updates: TaskBlockerUpdate): Promise<TaskBlocker | null> {
    if (!userId) return null

    // Convert updates for server
    const serverUpdates: Record<string, unknown> = {}
    if (updates.blockerReason !== undefined) serverUpdates.blockerReason = updates.blockerReason
    if (updates.blockerOwner !== undefined) serverUpdates.blockerOwner = updates.blockerOwner
    if (updates.reminderSet !== undefined)
      serverUpdates.reminderSet = updates.reminderSet?.toISOString() ?? null

    // Get the existing blocker to find its taskId
    const existingBlocker = blockers.find((b) => b.id === id)
    if (!existingBlocker) return null

    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        return await adapter.updateBlocker(id, updates)
      } catch (err) {
        blockersStore.setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : 'Failed to update blocker',
        }))
        return null
      }
    }

    try {
      const result = await updateMutation.mutateAsync({
        id,
        data: serverUpdates,
        userId,
        taskId: existingBlocker.taskId,
      })
      if (!result) throw new Error('Failed to update blocker')

      return {
        ...existingBlocker,
        ...updates,
        updatedAt: new Date(),
      }
    } catch (err) {
      // Fall back to localStorage
      try {
        const adapter = await initializeAssistantStorage()
        return await adapter.updateBlocker(id, updates)
      } catch {
        blockersStore.setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : 'Failed to update blocker',
        }))
        return null
      }
    }
  }

  /**
   * Resolve a blocker (marks as unblocked)
   */
  async function resolveBlocker(id: string): Promise<TaskBlocker | null> {
    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        return await adapter.resolveBlocker(id)
      } catch (err) {
        blockersStore.setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : 'Failed to resolve blocker',
        }))
        return null
      }
    }

    try {
      const existingBlocker = blockers.find((b) => b.id === id)
      if (!existingBlocker) throw new Error('Blocker not found')

      const result = await resolveMutation.mutateAsync({ id, userId: userId!, taskId: existingBlocker.taskId })
      if (!result) throw new Error('Failed to resolve blocker')

      return {
        ...existingBlocker,
        unblockedAt: new Date(),
        updatedAt: new Date(),
      }
    } catch (err) {
      blockersStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to resolve blocker',
      }))
      return null
    }
  }

  /**
   * Delete a blocker
   */
  async function deleteBlocker(id: string): Promise<boolean> {
    if (useFallback) {
      try {
        const adapter = getAssistantStorageAdapter()
        await adapter.deleteBlocker(id)
        return true
      } catch (err) {
        blockersStore.setState((s) => ({
          ...s,
          error: err instanceof Error ? err.message : 'Failed to delete blocker',
        }))
        return false
      }
    }

    // For server mode, we resolve the blocker instead of deleting
    // This preserves history
    const result = await resolveBlocker(id)
    return result !== null
  }

  /**
   * Get a blocker by ID
   */
  function getBlocker(id: string): TaskBlocker | undefined {
    return blockers.find((b) => b.id === id)
  }

  /**
   * Get all active (unresolved) blockers
   */
  function getActiveBlockers(): TaskBlocker[] {
    return blockers.filter((b) => !b.unblockedAt)
  }

  /**
   * Get all resolved blockers
   */
  function getResolvedBlockers(): TaskBlocker[] {
    return blockers.filter((b) => b.unblockedAt)
  }

  /**
   * Get blockers for a specific task
   */
  function getBlockersForTask(taskId: string): TaskBlocker[] {
    return blockers.filter((b) => b.taskId === taskId)
  }

  /**
   * Get active blocker for a task (if any)
   */
  function getActiveBlockerForTask(taskId: string): TaskBlocker | undefined {
    return blockers.find((b) => b.taskId === taskId && !b.unblockedAt)
  }

  /**
   * Check if a task is blocked
   */
  function isTaskBlocked(taskId: string): boolean {
    return blockers.some((b) => b.taskId === taskId && !b.unblockedAt)
  }

  /**
   * Get blockers by owner
   */
  function getBlockersByOwner(owner: string): TaskBlocker[] {
    return blockers.filter((b) => b.blockerOwner === owner)
  }

  /**
   * Get blockers with reminders set
   */
  function getBlockersWithReminders(): TaskBlocker[] {
    return blockers.filter((b) => b.reminderSet && !b.unblockedAt)
  }

  /**
   * Get blockers that have reminders due
   */
  function getBlockersWithDueReminders(): TaskBlocker[] {
    const now = new Date()
    return blockers.filter((b) => b.reminderSet && !b.unblockedAt && b.reminderSet <= now)
  }

  /**
   * Get long-standing blockers (blocked for more than N days)
   */
  function getLongStandingBlockers(days = 3): TaskBlocker[] {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return blockers.filter((b) => !b.unblockedAt && b.blockedSince <= cutoff)
  }

  /**
   * Get blocker duration in days
   */
  function getBlockerDurationDays(blocker: TaskBlocker): number {
    const endDate = blocker.unblockedAt ? blocker.unblockedAt : new Date()
    const startDate = blocker.blockedSince
    return Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  }

  /**
   * Get average block duration for resolved blockers
   */
  function getAverageBlockDuration(): number {
    const resolved = getResolvedBlockers()
    if (resolved.length === 0) return 0

    const totalDays = resolved.reduce((sum, b) => sum + getBlockerDurationDays(b), 0)
    return totalDays / resolved.length
  }

  /**
   * Clear error
   */
  function clearError() {
    blockersStore.setState((s) => ({ ...s, error: null }))
  }

  /**
   * Manual refresh
   */
  function refresh() {
    if (userId) {
      queryClient.invalidateQueries({ queryKey: assistantKeys.blockerList(userId) })
    }
  }

  return {
    // State
    blockers,
    loading,
    error: state.error,
    initialized,

    // CRUD operations
    addBlocker,
    updateBlocker,
    resolveBlocker,
    deleteBlocker,
    getBlocker,

    // Filters
    getActiveBlockers,
    getResolvedBlockers,
    getBlockersForTask,
    getActiveBlockerForTask,
    isTaskBlocked,
    getBlockersByOwner,
    getBlockersWithReminders,
    getBlockersWithDueReminders,
    getLongStandingBlockers,

    // Analytics
    getBlockerDurationDays,
    getAverageBlockDuration,

    // Utilities
    clearError,
    refresh,

    // Server status
    isServerMode: !useFallback,
  }
}
