import { Store } from '@tanstack/store'
import { useStore } from '@tanstack/react-store'
import { useEffect, useRef } from 'react'
import type { Timer, TimerInput, TimerUpdate, LapEntry } from '@dashboard/shared'
import { getStorageAdapter, initializeStorage } from '@/lib/timer/storage'

/**
 * Timer store state
 */
interface TimerStoreState {
  timers: Timer[]
  loading: boolean
  error: string | null
  initialized: boolean
}

/**
 * Create the timer store
 */
export const timerStore = new Store<TimerStoreState>({
  timers: [],
  loading: false,
  error: null,
  initialized: false,
})

/**
 * Hook to use the timer store with storage integration
 */
export function useTimerStore(userId: string | null) {
  const state = useStore(timerStore)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Initialize storage and subscribe to updates
  useEffect(() => {
    if (!userId) return

    // Capture userId as a non-null value for use inside the effect
    const currentUserId = userId

    let mounted = true

    async function init() {
      timerStore.setState((s) => ({ ...s, loading: true }))

      try {
        const adapter = await initializeStorage()

        // Set user ID for server sync
        adapter.setUserId(currentUserId)

        // Initial load
        const timers = await adapter.getTimers(currentUserId)
        if (mounted) {
          timerStore.setState((s) => ({
            ...s,
            timers,
            loading: false,
            initialized: true,
          }))
        }

        // Subscribe to updates (cross-tab sync)
        unsubscribeRef.current = adapter.watchTimers(currentUserId, (updatedTimers) => {
          if (mounted) {
            timerStore.setState((s) => ({ ...s, timers: updatedTimers }))
          }
        })
      } catch (err) {
        if (mounted) {
          timerStore.setState((s) => ({
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
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
      // Clear sync on unmount
      const adapter = getStorageAdapter()
      adapter.clearSync()
    }
  }, [userId])

  // Create timer
  async function createTimer(input: TimerInput): Promise<Timer | null> {
    if (!userId) return null

    try {
      const adapter = getStorageAdapter()
      const timer = await adapter.createTimer(input, userId)
      return timer
    } catch (err) {
      timerStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to create timer',
      }))
      return null
    }
  }

  // Update timer - PowerSync watch() will update state automatically
  async function updateTimer(id: string, updates: TimerUpdate): Promise<Timer | null> {
    try {
      const adapter = getStorageAdapter()
      const timer = await adapter.updateTimer(id, updates)
      // PowerSync watch() will update state automatically
      return timer
    } catch (err) {
      timerStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to update timer',
      }))
      return null
    }
  }

  // Delete timer
  async function deleteTimer(id: string): Promise<boolean> {
    try {
      const adapter = getStorageAdapter()
      await adapter.deleteTimer(id)
      return true
    } catch (err) {
      timerStore.setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to delete timer',
      }))
      return false
    }
  }

  // Get single timer from state
  function getTimer(id: string): Timer | undefined {
    return state.timers.find((t) => t.id === id)
  }

  // Add lap to timer
  async function addLap(timerId: string, elapsedMs: number): Promise<LapEntry | null> {
    const timer = state.timers.find((t) => t.id === timerId)
    if (!timer) return null

    const lapNumber = (timer.laps?.length ?? 0) + 1
    const previousLap = timer.laps?.[timer.laps.length - 1]
    const lapTime = previousLap ? elapsedMs - previousLap.splitTime : elapsedMs

    const newLap: LapEntry = {
      number: lapNumber,
      lapTime,
      splitTime: elapsedMs,
      timestamp: new Date(),
    }

    const updatedLaps = [...(timer.laps ?? []), newLap]

    await updateTimer(timerId, { laps: updatedLaps })
    return newLap
  }

  // Clear laps
  async function clearLaps(timerId: string): Promise<void> {
    await updateTimer(timerId, { laps: [] })
  }

  // Clear error
  function clearError() {
    timerStore.setState((s) => ({ ...s, error: null }))
  }

  return {
    timers: state.timers,
    loading: state.loading,
    error: state.error,
    initialized: state.initialized,
    createTimer,
    updateTimer,
    deleteTimer,
    getTimer,
    addLap,
    clearLaps,
    clearError,
  }
}
