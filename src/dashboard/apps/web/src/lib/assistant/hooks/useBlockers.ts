import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'
import type { TaskBlocker, TaskBlockerInput, TaskBlockerUpdate } from '@/lib/assistant/types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '@/lib/assistant/lib/storage'

/**
 * Blockers store state
 */
interface BlockersStoreState {
  blockers: TaskBlocker[]
  loading: boolean
  error: string | null
  initialized: boolean
}

/**
 * Create the blockers store
 */
export const blockersStore = new Store<BlockersStoreState>({
  blockers: [],
  loading: false,
  error: null,
  initialized: false,
})

/**
 * Hook to manage task blockers
 * Provides add/update/resolve blocker functionality
 */
export function useBlockers(userId: string | null) {
  const state = useStore(blockersStore)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Initialize storage and subscribe to updates
  useEffect(() => {
    if (!userId) return

    let mounted = true

    async function init() {
      blockersStore.setState((s) => ({ ...s, loading: true }))

      try {
        const adapter = await initializeAssistantStorage()

        // Initial load
        const blockers = await adapter.getBlockers(userId)

        if (mounted) {
          blockersStore.setState((s) => ({
            ...s,
            blockers,
            loading: false,
            initialized: true,
          }))
        }

        // Subscribe to updates
        unsubscribeRef.current = adapter.watchBlockers(userId, (updatedBlockers) => {
          if (mounted) {
            blockersStore.setState((s) => ({ ...s, blockers: updatedBlockers }))
          }
        })
      } catch (err) {
        if (mounted) {
          blockersStore.setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to initialize blockers',
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
    }
  }, [userId])

  /**
   * Add a new blocker to a task
   * Also marks the task as blocked
   */
  async function addBlocker(input: TaskBlockerInput): Promise<TaskBlocker | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const blocker = await adapter.createBlocker(input, userId)
      return blocker
    } catch (err) {
      blockersStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to add blocker',
      }))
      return null
    }
  }

  /**
   * Update an existing blocker
   */
  async function updateBlocker(id: string, updates: TaskBlockerUpdate): Promise<TaskBlocker | null> {
    // Optimistic update
    blockersStore.setState((s) => ({
      ...s,
      blockers: s.blockers.map((b) =>
        b.id === id ? { ...b, ...updates, updatedAt: new Date() } : b
      ),
    }))

    try {
      const adapter = getAssistantStorageAdapter()
      const blocker = await adapter.updateBlocker(id, updates)
      return blocker
    } catch (err) {
      // Rollback on error
      if (userId) {
        const adapter = getAssistantStorageAdapter()
        const blockers = await adapter.getBlockers(userId)
        blockersStore.setState((s) => ({
          ...s,
          blockers,
          error: err instanceof Error ? err.message : 'Failed to update blocker',
        }))
      }
      return null
    }
  }

  /**
   * Resolve a blocker (marks as unblocked)
   * Also updates task status if no other active blockers
   */
  async function resolveBlocker(id: string): Promise<TaskBlocker | null> {
    try {
      const adapter = getAssistantStorageAdapter()
      const blocker = await adapter.resolveBlocker(id)
      return blocker
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

  /**
   * Get a blocker by ID
   */
  function getBlocker(id: string): TaskBlocker | undefined {
    return state.blockers.find((b) => b.id === id)
  }

  /**
   * Get all active (unresolved) blockers
   */
  function getActiveBlockers(): TaskBlocker[] {
    return state.blockers.filter((b) => !b.unblockedAt)
  }

  /**
   * Get all resolved blockers
   */
  function getResolvedBlockers(): TaskBlocker[] {
    return state.blockers.filter((b) => b.unblockedAt)
  }

  /**
   * Get blockers for a specific task
   */
  function getBlockersForTask(taskId: string): TaskBlocker[] {
    return state.blockers.filter((b) => b.taskId === taskId)
  }

  /**
   * Get active blocker for a task (if any)
   */
  function getActiveBlockerForTask(taskId: string): TaskBlocker | undefined {
    return state.blockers.find((b) => b.taskId === taskId && !b.unblockedAt)
  }

  /**
   * Check if a task is blocked
   */
  function isTaskBlocked(taskId: string): boolean {
    return state.blockers.some((b) => b.taskId === taskId && !b.unblockedAt)
  }

  /**
   * Get blockers by owner
   */
  function getBlockersByOwner(owner: string): TaskBlocker[] {
    return state.blockers.filter((b) => b.blockerOwner === owner)
  }

  /**
   * Get blockers with reminders set
   */
  function getBlockersWithReminders(): TaskBlocker[] {
    return state.blockers.filter((b) => b.reminderSet && !b.unblockedAt)
  }

  /**
   * Get blockers that have reminders due
   */
  function getBlockersWithDueReminders(): TaskBlocker[] {
    const now = new Date()
    return state.blockers.filter(
      (b) => b.reminderSet && !b.unblockedAt && new Date(b.reminderSet) <= now
    )
  }

  /**
   * Get long-standing blockers (blocked for more than N days)
   */
  function getLongStandingBlockers(days = 3): TaskBlocker[] {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return state.blockers.filter(
      (b) => !b.unblockedAt && new Date(b.blockedSince) <= cutoff
    )
  }

  /**
   * Get blocker duration in days
   */
  function getBlockerDurationDays(blocker: TaskBlocker): number {
    const endDate = blocker.unblockedAt ? new Date(blocker.unblockedAt) : new Date()
    const startDate = new Date(blocker.blockedSince)
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

  return {
    // State
    blockers: state.blockers,
    loading: state.loading,
    error: state.error,
    initialized: state.initialized,

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
  }
}
