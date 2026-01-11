import { memo, useState, useCallback, useMemo } from 'react'
import { Trash2, MoreVertical, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TimerDisplay } from './TimerDisplay'
import { TimerControls } from './TimerControls'
import { TimerNameInput } from './TimerNameInput'
import { TimerTypeSelector } from './TimerTypeSelector'
import { TotalTimeBadge } from './TotalTimeBadge'
import { LapsList } from './LapsList'
import { useTimer } from '../hooks/useTimer'
import { formatTime } from '../hooks/useTimerEngine'

interface TimerCardProps {
  timerId: string
  userId: string | null
  onDelete?: (id: string) => void
  onPopout?: (id: string) => void
  className?: string
}

/**
 * Full timer card with cyberpunk glassmorphism styling
 */
export const TimerCard = memo(function TimerCard({
  timerId,
  userId,
  onDelete,
  onPopout,
  className,
}: TimerCardProps) {
  const [showMenu, setShowMenu] = useState(false)

  const {
    timer,
    displayTime,
    formattedTime,
    isRunning,
    reset,
    toggleRunning,
    addLap,
    clearLaps,
    setName,
    setType,
    toggleShowTotal,
    totalTimeElapsed,
  } = useTimer({ userId, timerId })

  // Countdown completion check
  const isCountdownComplete = useMemo(() => {
    if (!timer || timer.timerType !== 'countdown') return false
    return displayTime <= 0 && (timer.elapsedTime ?? 0) > 0
  }, [timer, displayTime])

  const handleDelete = useCallback(() => {
    if (onDelete) {
      onDelete(timerId)
    }
    setShowMenu(false)
  }, [onDelete, timerId])

  const handlePopout = useCallback(() => {
    if (onPopout) {
      onPopout(timerId)
    }
  }, [onPopout, timerId])

  if (!timer) {
    return (
      <div className={cn('animate-pulse rounded-xl bg-gray-800/50 h-48', className)} />
    )
  }

  return (
    <div
      className={cn(
        'group relative rounded-xl overflow-hidden',
        'bg-gray-900/95',
        'backdrop-blur-md',
        'border border-gray-800/80',
        'shadow-lg',
        'transition-all duration-300',
        'hover:border-amber-500/30',
        'hover:shadow-[0_0_20px_rgba(255,149,0,0.08)]',
        'animate-fade-in-up',
        className
      )}
    >
      {/* Subtle tech corner decorations */}
      <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-amber-500/20 rounded-tl-lg" />
      <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-amber-500/20 rounded-tr-lg" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-amber-500/20 rounded-bl-lg" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-amber-500/20 rounded-br-lg" />

      {/* Subtle glow around content area */}
      <div
        className={cn(
          'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full blur-2xl pointer-events-none',
          timer.timerType === 'stopwatch' && 'bg-cyan-500/15',
          timer.timerType === 'countdown' && 'bg-amber-500/15',
          timer.timerType === 'pomodoro' && 'bg-emerald-500/15'
        )}
      />

      {/* Content */}
      <div className="relative p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {/* Active indicator - green glowing dot */}
            {isRunning && (
              <span
                className={cn(
                  'flex-shrink-0 h-2 w-2 rounded-full',
                  timer.timerType === 'stopwatch' && 'bg-cyan-400 shadow-[0_0_8px_rgba(0,240,255,0.8)]',
                  timer.timerType === 'countdown' && 'bg-amber-400 shadow-[0_0_8px_rgba(255,149,0,0.8)]',
                  timer.timerType === 'pomodoro' && 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
                  'animate-pulse'
                )}
              />
            )}
            <TimerNameInput name={timer.name} onNameChange={setName} />
          </div>

          {/* Timer type selector - moved to row */}
          <TimerTypeSelector
            type={timer.timerType}
            onChange={setType}
            disabled={isRunning}
          />

          {/* Menu button */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className={cn(
                'p-2 rounded-lg',
                'text-gray-500 hover:text-gray-300',
                'hover:bg-gray-800/50',
                'transition-colors duration-200'
              )}
            >
              <MoreVertical className="h-5 w-5" />
            </button>

            {/* Dropdown menu */}
            {showMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowMenu(false)}
                />
                <div
                  className={cn(
                    'absolute right-0 top-full mt-2 z-50',
                    'w-48 py-2 rounded-xl',
                    'bg-gray-900 border border-gray-800',
                    'shadow-[0_0_30px_rgba(0,0,0,0.5)]',
                    'animate-fade-in-up'
                  )}
                >
                  <button
                    onClick={handleDelete}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5',
                      'text-sm text-red-400 hover:bg-red-500/10',
                      'transition-colors duration-200'
                    )}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete Timer</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Total time badge */}
        {timer.firstStartTime && (
          <TotalTimeBadge
            totalTimeMs={totalTimeElapsed}
            showTotal={timer.showTotal ?? false}
            onToggle={toggleShowTotal}
          />
        )}

        {/* Timer display */}
        <TimerDisplay
          time={formattedTime}
          isRunning={isRunning}
          timerType={timer.timerType}
          isCompleted={isCountdownComplete}
        />

        {/* Countdown duration display (when paused) */}
        {timer.timerType === 'countdown' && !isRunning && timer.duration && (
          <div className="flex items-center justify-center gap-2 text-sm text-amber-400/60">
            <Clock className="h-4 w-4" />
            <span>Duration: {formatTime(timer.duration, false)}</span>
          </div>
        )}

        {/* Controls */}
        <TimerControls
          isRunning={isRunning}
          timerType={timer.timerType}
          onToggle={toggleRunning}
          onReset={reset}
          onLap={addLap}
          onPopout={onPopout ? handlePopout : undefined}
        />

        {/* Laps list (stopwatch only) - compact with max height */}
        {timer.timerType === 'stopwatch' && timer.laps && timer.laps.length > 0 && (
          <LapsList laps={timer.laps} onClear={clearLaps} className="mt-2" />
        )}
      </div>
    </div>
  )
})
