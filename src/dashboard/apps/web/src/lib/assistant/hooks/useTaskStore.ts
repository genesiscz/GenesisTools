import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'
import type {
  Task,
  TaskInput,
  TaskUpdate,
  ContextParking,
  ContextParkingInput,
  CompletionEvent,
  Streak,
  Badge,
} from '@/lib/assistant/types'
import { getAssistantStorageAdapter, initializeAssistantStorage } from '@/lib/assistant/lib/storage'
import type { CompletionStats } from '@/lib/assistant/lib/storage/types'

/**
 * Task store state
 */
interface TaskStoreState {
  tasks: Task[]
  streak: Streak | null
  badges: Badge[]
  loading: boolean
  error: string | null
  initialized: boolean
}

/**
 * Create the task store
 */
export const taskStore = new Store<TaskStoreState>({
  tasks: [],
  streak: null,
  badges: [],
  loading: false,
  error: null,
  initialized: false,
})

/**
 * Hook to use the task store with storage integration
 */
export function useTaskStore(userId: string | null) {
  const state = useStore(taskStore)
  const unsubscribeRefs = useRef<Array<() => void>>([])

  // Initialize storage and subscribe to updates
  useEffect(() => {
    if (!userId) return

    const currentUserId = userId
    let mounted = true

    async function init() {
      taskStore.setState((s) => ({ ...s, loading: true }))

      try {
        const adapter = await initializeAssistantStorage()

        // Initial load
        const [tasks, streak, badges] = await Promise.all([
          adapter.getTasks(currentUserId),
          adapter.getStreak(currentUserId),
          adapter.getBadges(currentUserId),
        ])

        if (mounted) {
          taskStore.setState((s) => ({
            ...s,
            tasks,
            streak,
            badges,
            loading: false,
            initialized: true,
          }))
        }

        // Subscribe to updates (cross-tab sync)
        unsubscribeRefs.current = [
          adapter.watchTasks(currentUserId, (updatedTasks) => {
            if (mounted) {
              taskStore.setState((s) => ({ ...s, tasks: updatedTasks }))
            }
          }),
          adapter.watchStreak(currentUserId, (updatedStreak) => {
            if (mounted) {
              taskStore.setState((s) => ({ ...s, streak: updatedStreak }))
            }
          }),
          adapter.watchBadges(currentUserId, (updatedBadges) => {
            if (mounted) {
              taskStore.setState((s) => ({ ...s, badges: updatedBadges }))
            }
          }),
        ]
      } catch (err) {
        if (mounted) {
          taskStore.setState((s) => ({
            ...s,
            error: err instanceof Error ? err.message : 'Failed to initialize storage',
            loading: false,
          }))
        }
      }
    }

    init()

    return () => {
      mounted = false
      for (const unsub of unsubscribeRefs.current) {
        unsub()
      }
      unsubscribeRefs.current = []
    }
  }, [userId])

  // ============================================
  // Task Operations
  // ============================================

  async function createTask(input: TaskInput): Promise<Task | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const task = await adapter.createTask(input, userId)
      return task
    } catch (err) {
      taskStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to create task',
      }))
      return null
    }
  }

  async function updateTask(id: string, updates: TaskUpdate): Promise<Task | null> {
    // Optimistic update
    taskStore.setState((s) => ({
      ...s,
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...updates, updatedAt: new Date() } : t)),
    }))

    try {
      const adapter = getAssistantStorageAdapter()
      const task = await adapter.updateTask(id, updates)
      return task
    } catch (err) {
      // Rollback on error
      if (userId) {
        const adapter = getAssistantStorageAdapter()
        const tasks = await adapter.getTasks(userId)
        taskStore.setState((s) => ({
          ...s,
          tasks,
          error: err instanceof Error ? err.message : 'Failed to update task',
        }))
      }
      return null
    }
  }

  async function deleteTask(id: string): Promise<boolean> {
    try {
      const adapter = getAssistantStorageAdapter()
      await adapter.deleteTask(id)
      return true
    } catch (err) {
      taskStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to delete task',
      }))
      return false
    }
  }

  function getTask(id: string): Task | undefined {
    return state.tasks.find((t) => t.id === id)
  }

  // ============================================
  // Task Completion
  // ============================================

  async function completeTask(
    id: string
  ): Promise<{ task: Task; completion: CompletionEvent; newBadges: Badge[] } | null> {
    if (!userId) return null

    const task = state.tasks.find((t) => t.id === id)
    if (!task) return null

    try {
      const adapter = getAssistantStorageAdapter()

      // Update task status
      const completedTask = await adapter.updateTask(id, {
        status: 'completed',
        completedAt: new Date(),
      })

      // Log completion
      const completion = await adapter.logCompletion(
        {
          taskId: id,
          completionType: 'task-complete',
          metadata: {
            focusTimeSpent: task.focusTimeLogged,
            taskUrgency: task.urgencyLevel,
          },
        },
        userId
      )

      // Update streak
      const streak = await adapter.updateStreak(userId)
      taskStore.setState((s) => ({ ...s, streak }))

      // Check for new badges
      const eligibleBadges = await adapter.checkBadgeEligibility(userId)
      const newBadges: Badge[] = []

      for (const badgeType of eligibleBadges) {
        const badge = await adapter.awardBadge(userId, badgeType)
        newBadges.push(badge)
      }

      return { task: completedTask, completion, newBadges }
    } catch (err) {
      taskStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to complete task',
      }))
      return null
    }
  }

  // ============================================
  // Context Parking
  // ============================================

  async function parkContext(input: ContextParkingInput): Promise<ContextParking | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      const parking = await adapter.parkContext(input, userId)
      return parking
    } catch (err) {
      taskStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to park context',
      }))
      return null
    }
  }

  async function getActiveParking(taskId: string): Promise<ContextParking | null> {
    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getActiveParking(taskId)
    } catch {
      return null
    }
  }

  async function getParkingHistory(taskId?: string): Promise<ContextParking[]> {
    if (!userId) return []

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getParkingHistory(userId, taskId)
    } catch {
      return []
    }
  }

  async function resumeParking(parkingId: string): Promise<ContextParking | null> {
    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.resumeParking(parkingId)
    } catch (err) {
      taskStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to resume parking',
      }))
      return null
    }
  }

  // ============================================
  // Statistics
  // ============================================

  async function getCompletionStats(): Promise<CompletionStats | null> {
    if (!userId) return null

    try {
      const adapter = getAssistantStorageAdapter()
      return await adapter.getCompletionStats(userId)
    } catch {
      return null
    }
  }

  // ============================================
  // Utilities
  // ============================================

  function clearError() {
    taskStore.setState((s) => ({ ...s, error: null }))
  }

  // Filter helpers
  function getTasksByStatus(status: Task['status']): Task[] {
    return state.tasks.filter((t) => t.status === status)
  }

  function getTasksByUrgency(urgency: Task['urgencyLevel']): Task[] {
    return state.tasks.filter((t) => t.urgencyLevel === urgency)
  }

  function getActiveTasks(): Task[] {
    return state.tasks.filter((t) => t.status !== 'completed')
  }

  function getCriticalTasks(): Task[] {
    return state.tasks.filter((t) => t.urgencyLevel === 'critical' && t.status !== 'completed')
  }

  return {
    // State
    tasks: state.tasks,
    streak: state.streak,
    badges: state.badges,
    loading: state.loading,
    error: state.error,
    initialized: state.initialized,

    // Task operations
    createTask,
    updateTask,
    deleteTask,
    getTask,
    completeTask,

    // Context parking
    parkContext,
    getActiveParking,
    getParkingHistory,
    resumeParking,

    // Statistics
    getCompletionStats,

    // Utilities
    clearError,
    getTasksByStatus,
    getTasksByUrgency,
    getActiveTasks,
    getCriticalTasks,
  }
}
