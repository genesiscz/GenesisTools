import { useRef, useCallback, useEffect, useState } from 'react'
import type { Timer } from '@dashboard/shared'

/**
 * Timer engine state
 */
interface TimerEngineState {
  displayTime: number
  isRunning: boolean
}

/**
 * Hook that manages the timer display loop using requestAnimationFrame
 *
 * This hook provides accurate time tracking by calculating elapsed time
 * from the start timestamp rather than incrementing a counter
 */
export function useTimerEngine(timer: Timer | null | undefined) {
  const [state, setState] = useState<TimerEngineState>({
    displayTime: 0,
    isRunning: false,
  })

  const animationFrameRef = useRef<number | null>(null)
  const lastUpdateRef = useRef<number>(0)

  // Calculate current elapsed time based on timer state
  const calculateElapsed = useCallback((): number => {
    if (!timer) return 0

    const baseElapsed = timer.elapsedTime ?? 0

    if (timer.isRunning && timer.startTime) {
      const startTime =
        timer.startTime instanceof Date ? timer.startTime.getTime() : new Date(timer.startTime).getTime()
      const now = Date.now()
      const sessionElapsed = now - startTime

      if (timer.timerType === 'countdown') {
        // Countdown: duration - elapsed
        const remaining = (timer.duration ?? 0) - (baseElapsed + sessionElapsed)
        return Math.max(0, remaining)
      }

      // Stopwatch/Pomodoro: accumulate elapsed
      return baseElapsed + sessionElapsed
    }

    // Not running - return base elapsed or remaining for countdown
    if (timer.timerType === 'countdown') {
      return Math.max(0, (timer.duration ?? 0) - baseElapsed)
    }

    return baseElapsed
  }, [timer])

  // Animation loop
  const tick = useCallback(() => {
    const now = performance.now()

    // Throttle updates to ~60fps (16.67ms)
    if (now - lastUpdateRef.current >= 16) {
      const elapsed = calculateElapsed()
      setState((s) => ({ ...s, displayTime: elapsed }))
      lastUpdateRef.current = now
    }

    animationFrameRef.current = requestAnimationFrame(tick)
  }, [calculateElapsed])

  // Start/stop the animation loop based on timer running state
  useEffect(() => {
    const isRunning = timer?.isRunning ?? false

    if (isRunning) {
      // Start animation loop
      lastUpdateRef.current = performance.now()
      animationFrameRef.current = requestAnimationFrame(tick)
      setState((s) => ({ ...s, isRunning: true }))
    } else {
      // Stop animation loop
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      // Update to final elapsed time
      const elapsed = calculateElapsed()
      setState({ displayTime: elapsed, isRunning: false })
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [timer?.isRunning, timer?.startTime, tick, calculateElapsed])

  // Update display time when timer changes externally (e.g., reset)
  useEffect(() => {
    if (!timer?.isRunning) {
      const elapsed = calculateElapsed()
      setState((s) => ({ ...s, displayTime: elapsed }))
    }
  }, [timer?.elapsedTime, timer?.duration, calculateElapsed, timer?.isRunning])

  return {
    displayTime: state.displayTime,
    isRunning: state.isRunning,
    calculateElapsed,
  }
}

/**
 * Format milliseconds to display string
 */
export function formatTime(ms: number, showMilliseconds = true): string {
  const totalSeconds = Math.floor(Math.abs(ms) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const milliseconds = Math.floor((Math.abs(ms) % 1000) / 10)

  let result = ''

  if (hours > 0) {
    result = `${hours.toString().padStart(2, '0')}:`
  }

  result += `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`

  if (showMilliseconds) {
    result += `.${milliseconds.toString().padStart(2, '0')}`
  }

  return result
}

/**
 * Format milliseconds to compact string (for laps)
 */
export function formatTimeCompact(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const centiseconds = Math.floor((ms % 1000) / 10)

  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`
  }

  return `${seconds}.${centiseconds.toString().padStart(2, '0')}`
}
