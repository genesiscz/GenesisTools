import type { Timer, TimerType, ActivityLogInput } from '@dashboard/shared'
import { useTimerStore } from './useTimerStore'
import { useTimerEngine, formatTime, formatTimeCompact } from './useTimerEngine'
import { getStorageAdapter } from '@/lib/timer/storage'

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

  // Log activity helper
  async function logActivity(eventType: ActivityLogInput['eventType'], extras: Partial<ActivityLogInput> = {}) {
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
  }

  // Start timer
  async function start() {
    if (!timer) return

    const now = new Date()
    const updates: Partial<Timer> = {
      isRunning: true,
      startTime: now,
    }

    // Calculate pause duration if timer was previously paused (not first start)
    let pauseDuration: number | undefined
    if (timer.updatedAt && !timer.isRunning && timer.elapsedTime && timer.elapsedTime > 0) {
      const lastPausedAt = timer.updatedAt instanceof Date
        ? timer.updatedAt.getTime()
        : new Date(timer.updatedAt).getTime()
      pauseDuration = now.getTime() - lastPausedAt
    }

    // Set firstStartTime if this is the first time starting
    if (!timer.firstStartTime) {
      updates.firstStartTime = now
    }

    await updateTimer(timerId, updates)
    await logActivity('start', pauseDuration ? { metadata: { pauseDuration } } : {})
  }

  // Pause timer
  async function pause() {
    if (!timer || !timer.isRunning || !timer.startTime) return

    const startTime = timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime()
    const sessionDuration = Date.now() - startTime
    const newElapsed = (timer.elapsedTime ?? 0) + sessionDuration

    await updateTimer(timerId, {
      isRunning: false,
      startTime: null,
      elapsedTime: newElapsed,
    })

    await logActivity('pause', { sessionDuration, elapsedAtEvent: newElapsed })
  }

  // Toggle running state
  async function toggleRunning() {
    if (timer?.isRunning) {
      await pause()
    } else {
      await start()
    }
  }

  // Reset timer
  async function reset() {
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
  }

  // Add lap
  async function addLap() {
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
  }

  // Clear laps
  async function clearLaps() {
    await clearLapsFromStore(timerId)
  }

  // Set timer name
  async function setName(name: string) {
    await updateTimer(timerId, { name })
  }

  // Set countdown duration (only when paused) - also reset elapsedTime
  async function setDuration(durationMs: number) {
    if (timer?.isRunning) return
    await updateTimer(timerId, { duration: durationMs, elapsedTime: 0 })
  }

  // Set timer type
  async function setType(type: TimerType) {
    await updateTimer(timerId, { timerType: type })
  }

  // Edit elapsed time (manual adjustment when paused)
  async function editElapsedTime(newElapsedMs: number) {
    if (!timer || timer.isRunning) return

    const previousValue = timer.elapsedTime ?? 0

    await updateTimer(timerId, { elapsedTime: newElapsedMs })

    await logActivity('time_edit', {
      previousValue,
      newValue: newElapsedMs,
    })
  }

  // Toggle show total time
  async function toggleShowTotal() {
    if (!timer) return
    await updateTimer(timerId, { showTotal: !timer.showTotal })
  }

  // Calculate total time since first start
  function calcTotalTimeElapsed(): number {
    if (!timer?.firstStartTime) return 0

    const firstStart =
      timer.firstStartTime instanceof Date ? timer.firstStartTime.getTime() : new Date(timer.firstStartTime).getTime()

    return Date.now() - firstStart
  }

  // Completion percentage (for countdown/pomodoro)
  function calcCompletionPercentage(): number {
    if (!timer || timer.timerType === 'stopwatch') return 0
    if (!timer.duration) return 0

    const elapsed = timer.elapsedTime ?? 0
    return Math.min(100, (elapsed / timer.duration) * 100)
  }

  const totalTimeElapsed = calcTotalTimeElapsed()
  const completionPercentage = calcCompletionPercentage()

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
