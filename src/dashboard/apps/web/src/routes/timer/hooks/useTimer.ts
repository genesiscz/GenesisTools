import { useCallback, useMemo } from 'react'
import type { Timer, TimerType, ActivityLogInput } from '@dashboard/shared'
import { useTimerStore } from './useTimerStore'
import { useTimerEngine, formatTime, formatTimeCompact } from './useTimerEngine'
import { getStorageAdapter } from '../lib/storage'

interface UseTimerOptions {
  userId: string | null
  timerId: string
}

interface UseTimerReturn {
  timer: Timer | undefined
  displayTime: number
  formattedTime: string
  formattedTimeCompact: string
  isRunning: boolean
  // Actions
  start: () => Promise<void>
  pause: () => Promise<void>
  reset: () => Promise<void>
  toggleRunning: () => Promise<void>
  addLap: () => Promise<void>
  clearLaps: () => Promise<void>
  setName: (name: string) => Promise<void>
  setDuration: (durationMs: number) => Promise<void>
  setType: (type: TimerType) => Promise<void>
  editElapsedTime: (newElapsedMs: number) => Promise<void>
  toggleShowTotal: () => Promise<void>
  // Computed
  totalTimeElapsed: number
  completionPercentage: number
}

/**
 * Hook for controlling an individual timer
 */
export function useTimer({ userId, timerId }: UseTimerOptions): UseTimerReturn {
  const { getTimer, updateTimer, addLap: addLapToStore, clearLaps: clearLapsFromStore } = useTimerStore(userId)

  const timer = getTimer(timerId)
  const { displayTime, isRunning } = useTimerEngine(timer)

  // Log activity
  const logActivity = useCallback(
    async (eventType: ActivityLogInput['eventType'], extras: Partial<ActivityLogInput> = {}) => {
      if (!timer || !userId) return

      const adapter = getStorageAdapter()
      await adapter.logActivity({
        timerId: timer.id,
        timerName: timer.name,
        userId,
        eventType,
        timestamp: new Date(),
        elapsedAtEvent: timer.elapsedTime ?? 0,
        ...extras,
      })
    },
    [timer, userId]
  )

  // Start timer
  const start = useCallback(async () => {
    if (!timer) return

    const now = new Date()
    const updates: Partial<Timer> = {
      isRunning: true,
      startTime: now,
    }

    // Set firstStartTime if this is the first time starting
    if (!timer.firstStartTime) {
      updates.firstStartTime = now
    }

    await updateTimer(timerId, updates)
    await logActivity('start')
  }, [timer, timerId, updateTimer, logActivity])

  // Pause timer
  const pause = useCallback(async () => {
    if (!timer || !timer.isRunning || !timer.startTime) return

    const startTime = timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime()
    const sessionDuration = Date.now() - startTime
    const newElapsed = (timer.elapsedTime ?? 0) + sessionDuration

    await updateTimer(timerId, {
      isRunning: false,
      startTime: null,
      elapsedTime: newElapsed,
    })

    await logActivity('pause', { sessionDuration })
  }, [timer, timerId, updateTimer, logActivity])

  // Toggle running state
  const toggleRunning = useCallback(async () => {
    if (timer?.isRunning) {
      await pause()
    } else {
      await start()
    }
  }, [timer?.isRunning, start, pause])

  // Reset timer
  const reset = useCallback(async () => {
    if (!timer) return

    // Calculate elapsed at event before reset
    let elapsedAtEvent = timer.elapsedTime ?? 0
    if (timer.isRunning && timer.startTime) {
      const startTime =
        timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime()
      elapsedAtEvent += Date.now() - startTime
    }

    await updateTimer(timerId, {
      isRunning: false,
      startTime: null,
      elapsedTime: 0,
      laps: [],
      // Reset pomodoro session count if resetting
      pomodoroSessionCount: 0,
    })

    await logActivity('reset', { elapsedAtEvent })
  }, [timer, timerId, updateTimer, logActivity])

  // Add lap
  const addLap = useCallback(async () => {
    if (!timer) return

    // Calculate current elapsed
    let currentElapsed = timer.elapsedTime ?? 0
    if (timer.isRunning && timer.startTime) {
      const startTime =
        timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime()
      currentElapsed += Date.now() - startTime
    }

    const lap = await addLapToStore(timerId, currentElapsed)
    if (lap) {
      await logActivity('lap', {
        elapsedAtEvent: currentElapsed,
        metadata: { lapNumber: lap.number, lapTime: lap.lapTime },
      })
    }
  }, [timer, timerId, addLapToStore, logActivity])

  // Clear laps
  const clearLaps = useCallback(async () => {
    await clearLapsFromStore(timerId)
  }, [timerId, clearLapsFromStore])

  // Set timer name
  const setName = useCallback(
    async (name: string) => {
      await updateTimer(timerId, { name })
    },
    [timerId, updateTimer]
  )

  // Set countdown duration (only when paused)
  const setDuration = useCallback(
    async (durationMs: number) => {
      if (timer?.isRunning) return
      await updateTimer(timerId, { duration: durationMs })
    },
    [timer?.isRunning, timerId, updateTimer]
  )

  // Set timer type
  const setType = useCallback(
    async (type: TimerType) => {
      await updateTimer(timerId, { timerType: type })
    },
    [timerId, updateTimer]
  )

  // Edit elapsed time (manual adjustment when paused)
  const editElapsedTime = useCallback(
    async (newElapsedMs: number) => {
      if (!timer || timer.isRunning) return

      const previousValue = timer.elapsedTime ?? 0

      await updateTimer(timerId, { elapsedTime: newElapsedMs })

      await logActivity('time_edit', {
        previousValue,
        newValue: newElapsedMs,
      })
    },
    [timer, timerId, updateTimer, logActivity]
  )

  // Toggle show total time
  const toggleShowTotal = useCallback(async () => {
    if (!timer) return
    await updateTimer(timerId, { showTotal: !timer.showTotal })
  }, [timer, timerId, updateTimer])

  // Calculate total time since first start
  const totalTimeElapsed = useMemo(() => {
    if (!timer?.firstStartTime) return 0

    const firstStart =
      timer.firstStartTime instanceof Date ? timer.firstStartTime.getTime() : new Date(timer.firstStartTime).getTime()

    return Date.now() - firstStart
  }, [timer?.firstStartTime])

  // Completion percentage (for countdown/pomodoro)
  const completionPercentage = useMemo(() => {
    if (!timer || timer.timerType === 'stopwatch') return 0
    if (!timer.duration) return 0

    const elapsed = timer.elapsedTime ?? 0
    return Math.min(100, (elapsed / timer.duration) * 100)
  }, [timer])

  return {
    timer,
    displayTime,
    formattedTime: formatTime(displayTime),
    formattedTimeCompact: formatTimeCompact(displayTime),
    isRunning,
    start,
    pause,
    reset,
    toggleRunning,
    addLap,
    clearLaps,
    setName,
    setDuration,
    setType,
    editElapsedTime,
    toggleShowTotal,
    totalTimeElapsed,
    completionPercentage,
  }
}
