import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Play, Pause, RotateCcw, Trash2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatTime, generateTimerId } from '@dashboard/shared'
import type { Timer, TimerType } from '@dashboard/shared'
import '@/components/auth/cyberpunk.css'

export const Route = createFileRoute('/timer/')({
  component: TimerPage,
})

interface LocalTimer extends Omit<Timer, 'userId' | 'createdAt' | 'updatedAt'> {
  startTime: number | null
  firstStartTime: number | null
}

function TimerPage() {
  const [timers, setTimers] = useState<LocalTimer[]>([])
  const [, forceUpdate] = useState(0)

  // Add new timer
  const addTimer = useCallback(() => {
    const newTimer: LocalTimer = {
      id: generateTimerId(),
      name: `Timer ${timers.length + 1}`,
      type: 'stopwatch' as TimerType,
      isRunning: false,
      pausedTime: 0,
      countdownDuration: 5 * 60 * 1000, // 5 minutes default
      laps: [],
      startTime: null,
      firstStartTime: null,
    }
    setTimers(prev => [...prev, newTimer])
  }, [timers.length])

  // Start/pause timer
  const toggleTimer = useCallback((id: string) => {
    setTimers(prev => prev.map(timer => {
      if (timer.id !== id) return timer

      if (timer.isRunning) {
        // Pause
        const elapsed = timer.startTime ? performance.now() - timer.startTime : 0
        return {
          ...timer,
          isRunning: false,
          pausedTime: timer.pausedTime + elapsed,
          startTime: null,
        }
      } else {
        // Start
        return {
          ...timer,
          isRunning: true,
          startTime: performance.now(),
          firstStartTime: timer.firstStartTime ?? performance.now(),
        }
      }
    }))
  }, [])

  // Reset timer
  const resetTimer = useCallback((id: string) => {
    setTimers(prev => prev.map(timer => {
      if (timer.id !== id) return timer
      return {
        ...timer,
        isRunning: false,
        pausedTime: 0,
        startTime: null,
        firstStartTime: null,
        laps: [],
      }
    }))
  }, [])

  // Delete timer
  const deleteTimer = useCallback((id: string) => {
    setTimers(prev => prev.filter(timer => timer.id !== id))
  }, [])

  // Get current time for a timer
  const getCurrentTime = useCallback((timer: LocalTimer): number => {
    let elapsed = timer.pausedTime
    if (timer.isRunning && timer.startTime) {
      elapsed += performance.now() - timer.startTime
    }

    if (timer.type === 'countdown') {
      return Math.max(0, timer.countdownDuration - elapsed)
    }
    return elapsed
  }, [])

  // Animation frame for running timers
  useEffect(() => {
    let animationId: number
    const hasRunning = timers.some(t => t.isRunning)

    const tick = () => {
      if (hasRunning) {
        forceUpdate(n => n + 1)
        animationId = requestAnimationFrame(tick)
      }
    }

    if (hasRunning) {
      animationId = requestAnimationFrame(tick)
    }

    return () => {
      if (animationId) cancelAnimationFrame(animationId)
    }
  }, [timers])

  return (
    <div className="min-h-screen bg-[#030308] text-white">
      {/* Cyberpunk background effects */}
      <div className="fixed inset-0 cyber-grid opacity-20" />
      <div className="fixed inset-0 scan-lines pointer-events-none" />

      {/* Header */}
      <header className="relative z-10 border-b border-amber-500/20 bg-black/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold gradient-text">CHRONO // TERMINAL</h1>
          <Button
            onClick={addTimer}
            className="bg-amber-500 hover:bg-amber-600 text-black neon-glow"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Timer
          </Button>
        </div>
      </header>

      {/* Main content */}
      <main className="relative z-10 container mx-auto px-6 py-8">
        {timers.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-gray-500 mb-4">No timers yet</div>
            <Button
              onClick={addTimer}
              variant="outline"
              className="border-amber-500/30 hover:bg-amber-500/10"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create your first timer
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {timers.map(timer => (
              <TimerCard
                key={timer.id}
                timer={timer}
                currentTime={getCurrentTime(timer)}
                onToggle={() => toggleTimer(timer.id)}
                onReset={() => resetTimer(timer.id)}
                onDelete={() => deleteTimer(timer.id)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

interface TimerCardProps {
  timer: LocalTimer
  currentTime: number
  onToggle: () => void
  onReset: () => void
  onDelete: () => void
}

function TimerCard({ timer, currentTime, onToggle, onReset, onDelete }: TimerCardProps) {
  return (
    <div className="glass-card rounded-2xl p-6 neon-border tech-corner animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <input
          type="text"
          defaultValue={timer.name}
          className="bg-transparent border-none text-lg font-semibold text-white focus:outline-none focus:ring-1 focus:ring-amber-500/50 rounded px-1 -ml-1"
        />
        <button
          onClick={onDelete}
          className="p-2 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-400 transition-colors"
          title="Delete timer"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Timer type indicator */}
      <div className="flex items-center gap-2 mb-4">
        <span className={`text-xs uppercase tracking-wider ${timer.type === 'stopwatch' ? 'text-cyan-400' : 'text-amber-400'}`}>
          {timer.type}
        </span>
        {timer.isRunning && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running
          </span>
        )}
      </div>

      {/* Time display */}
      <div className={`text-4xl md:text-5xl font-mono text-center py-6 neon-cyan ${timer.isRunning ? 'animate-pulse-glow' : ''}`}>
        {formatTime(currentTime)}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-3">
        <Button
          onClick={onToggle}
          className={timer.isRunning
            ? "bg-amber-500 hover:bg-amber-600 text-black"
            : "bg-emerald-500 hover:bg-emerald-600 text-black"
          }
        >
          {timer.isRunning ? (
            <><Pause className="h-4 w-4 mr-2" /> Pause</>
          ) : (
            <><Play className="h-4 w-4 mr-2" /> Start</>
          )}
        </Button>
        <Button
          onClick={onReset}
          variant="outline"
          className="border-amber-500/30 hover:bg-amber-500/10"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="border-amber-500/30 hover:bg-amber-500/10"
          title="Pop out"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
