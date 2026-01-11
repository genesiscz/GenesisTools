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
      <div className={cn('animate-pulse rounded-2xl bg-gray-800/50 h-64', className)} />
    )
  }

  return (
    <div
      className={cn(
        'group relative rounded-2xl overflow-hidden',
        'bg-gradient-to-br from-gray-900/90 via-gray-900/80 to-gray-950/90',
        'backdrop-blur-xl',
        'border border-amber-500/20',
        'shadow-[0_0_30px_rgba(0,0,0,0.5)]',
        'transition-all duration-500',
        'hover:border-amber-500/40',
        'hover:shadow-[0_0_40px_rgba(255,149,0,0.1)]',
        'animate-fade-in-up',
        className
      )}
    >
      {/* Tech corner decorations */}
      <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-amber-500/40 rounded-tl-xl" />
      <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-amber-500/40 rounded-tr-xl" />
      <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-amber-500/40 rounded-bl-xl" />
      <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-amber-500/40 rounded-br-xl" />

      {/* Ambient glow based on timer type */}
      <div
        className={cn(
          'absolute -inset-1 -z-10 blur-3xl opacity-10 transition-opacity duration-500',
          timer.timerType === 'stopwatch' && 'bg-cyan-500',
          timer.timerType === 'countdown' && 'bg-amber-500',
          timer.timerType === 'pomodoro' && 'bg-emerald-500',
          isRunning && 'opacity-20'
        )}
      />

      {/* Content */}
      <div className="relative p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <TimerNameInput name={timer.name} onNameChange={setName} />

            {/* Timer type selector */}
            <div className="mt-3">
              <TimerTypeSelector
                type={timer.timerType}
                onChange={setType}
                disabled={isRunning}
              />
            </div>
          </div>

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

        {/* Laps list (stopwatch only) */}
        {timer.timerType === 'stopwatch' && timer.laps && timer.laps.length > 0 && (
          <LapsList laps={timer.laps} onClear={clearLaps} className="mt-6" />
        )}
      </div>
    </div>
  )
})
