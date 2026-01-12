import { memo, useState } from 'react'
import { Trash2, MoreVertical, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TimerDisplay } from './TimerDisplay'
import { TimerControls } from './TimerControls'
import { TimerNameInput } from './TimerNameInput'
import { TimerTypeSelector } from './TimerTypeSelector'
import { TotalTimeBadge } from './TotalTimeBadge'
import { LapsList } from './LapsList'
import { TimeEditor } from './TimeEditor'
import { CountdownPicker } from './CountdownPicker'
import { PomodoroSteps } from './PomodoroSteps'
import { useTimer } from '@/lib/timer/hooks/useTimer'
import { formatTime } from '@/lib/timer/hooks/useTimerEngine'

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
  const [isEditingTime, setIsEditingTime] = useState(false)

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
    editElapsedTime,
    setDuration,
  } = useTimer({ userId, timerId })

  // Countdown completion check
  const isCountdownComplete = timer?.timerType === 'countdown' && displayTime <= 0 && (timer.elapsedTime ?? 0) > 0

  function handleDelete() {
    if (onDelete) {
      onDelete(timerId)
    }
    setShowMenu(false)
  }

  function handlePopout() {
    if (onPopout) {
      onPopout(timerId)
    }
  }

  function handleTimeEdit() {
    if (!isRunning) {
      setIsEditingTime(true)
    }
  }

  async function handleTimeSave(newTimeMs: number) {
    await editElapsedTime(newTimeMs)
    setIsEditingTime(false)
  }

  async function handleDurationSelect(durationMs: number) {
    await setDuration(durationMs)
    setIsEditingTime(false)
  }

  if (!timer) {
    return (
      <div className={cn('animate-pulse rounded-xl bg-gray-800/50 h-48', className)} />
    )
  }

  // Color classes based on timer type
  const colorClasses = {
    stopwatch: {
      border: 'border-cyan-500/30 hover:border-cyan-500/50',
      corner: 'border-cyan-500/40 group-hover:border-cyan-500/70',
      glow: 'bg-cyan-500/15',
      shadow: 'hover:shadow-cyan-500/20',
    },
    countdown: {
      border: 'border-amber-500/30 hover:border-amber-500/50',
      corner: 'border-amber-500/40 group-hover:border-amber-500/70',
      glow: 'bg-amber-500/15',
      shadow: 'hover:shadow-amber-500/20',
    },
    pomodoro: {
      border: 'border-emerald-500/30 hover:border-emerald-500/50',
      corner: 'border-emerald-500/40 group-hover:border-emerald-500/70',
      glow: 'bg-emerald-500/15',
      shadow: 'hover:shadow-emerald-500/20',
    },
  }

  const colors = colorClasses[timer.timerType as keyof typeof colorClasses]

  return (
    <div
      className={cn(
        'group relative rounded-xl overflow-hidden',
        'bg-gray-900/95',
        'backdrop-blur-md',
        'border',
        colors.border,
        'shadow-lg',
        'transition-all duration-300',
        'hover:shadow-lg',
        colors.shadow,
        className
      )}
    >
      {/* Tech corner decorations */}
      <div className={cn('absolute top-0 left-0 w-5 h-5 border-l-2 border-t-2 rounded-tl-lg transition-colors', colors.corner)} />
      <div className={cn('absolute top-0 right-0 w-5 h-5 border-r-2 border-t-2 rounded-tr-lg transition-colors', colors.corner)} />
      <div className={cn('absolute bottom-0 left-0 w-5 h-5 border-l-2 border-b-2 rounded-bl-lg transition-colors', colors.corner)} />
      <div className={cn('absolute bottom-0 right-0 w-5 h-5 border-r-2 border-b-2 rounded-br-lg transition-colors', colors.corner)} />

      {/* Subtle glow around content area */}
      <div
        className={cn(
          'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full blur-2xl pointer-events-none',
          colors.glow
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

        {/* Timer display - clickable when not running */}
        {isEditingTime ? (
          timer.timerType === 'stopwatch' ? (
            <TimeEditor
              timeMs={timer.elapsedTime ?? 0}
              onSave={handleTimeSave}
              onCancel={() => setIsEditingTime(false)}
            />
          ) : timer.timerType === 'countdown' ? (
            <CountdownPicker
              onSelect={handleDurationSelect}
            />
          ) : (
            // Pomodoro - edit current phase duration
            <TimeEditor
              timeMs={displayTime}
              onSave={handleTimeSave}
              onCancel={() => setIsEditingTime(false)}
            />
          )
        ) : (
          <button
            onClick={handleTimeEdit}
            disabled={isRunning}
            className={cn(
              'w-full rounded-lg transition-colors',
              !isRunning && 'hover:bg-gray-800/50 cursor-pointer',
              isRunning && 'cursor-default'
            )}
          >
            <TimerDisplay
              time={formattedTime}
              isRunning={isRunning}
              timerType={timer.timerType}
              isCompleted={isCountdownComplete}
            />
          </button>
        )}

        {/* Countdown duration display (when paused and not editing) */}
        {timer.timerType === 'countdown' && !isRunning && !isEditingTime && timer.duration && (
          <div className="flex items-center justify-center gap-2 text-sm text-amber-400/60">
            <Clock className="h-4 w-4" />
            <span>Duration: {formatTime(timer.duration, false)}</span>
          </div>
        )}

        {/* Pomodoro steps display */}
        {timer.timerType === 'pomodoro' && (() => {
          const pomodoroSettings = timer.pomodoroSettings ?? {
            workDuration: 25 * 60 * 1000,
            shortBreakDuration: 5 * 60 * 1000,
            longBreakDuration: 15 * 60 * 1000,
            sessionsBeforeLongBreak: 4,
          }
          // Calculate progress based on current phase
          let phaseDuration = pomodoroSettings.workDuration
          if (timer.pomodoroPhase === 'short_break') {
            phaseDuration = pomodoroSettings.shortBreakDuration
          } else if (timer.pomodoroPhase === 'long_break') {
            phaseDuration = pomodoroSettings.longBreakDuration
          }
          const progress = phaseDuration > 0 ? displayTime / phaseDuration : 0

          return (
            <PomodoroSteps
              settings={pomodoroSettings}
              currentPhase={timer.pomodoroPhase}
              sessionCount={timer.pomodoroSessionCount ?? 0}
              progress={progress}
            />
          )
        })()}

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
