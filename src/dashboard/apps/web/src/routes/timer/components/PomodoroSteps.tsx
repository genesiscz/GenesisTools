import { cn } from '@/lib/utils'
import { Coffee, Zap } from 'lucide-react'
import type { PomodoroSettings } from '@dashboard/shared'

interface PomodoroStepsProps {
  settings: PomodoroSettings
  currentPhase: 'work' | 'short_break' | 'long_break' | undefined
  sessionCount: number
  className?: string
}

const DEFAULT_SETTINGS: PomodoroSettings = {
  workDuration: 25 * 60 * 1000,
  shortBreakDuration: 5 * 60 * 1000,
  longBreakDuration: 15 * 60 * 1000,
  sessionsBeforeLongBreak: 4,
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60000)
  return `${minutes}m`
}

/**
 * Shows the Pomodoro cycle steps with current position highlighted
 */
export function PomodoroSteps({
  settings = DEFAULT_SETTINGS,
  currentPhase,
  sessionCount,
  className,
}: PomodoroStepsProps) {
  const config = { ...DEFAULT_SETTINGS, ...settings }
  const totalSessions = config.sessionsBeforeLongBreak

  // Build the steps array
  // Pattern: work -> break -> work -> break -> ... -> work -> long break
  const steps: Array<{
    type: 'work' | 'short_break' | 'long_break'
    label: string
    duration: string
  }> = []

  for (let i = 0; i < totalSessions; i++) {
    steps.push({
      type: 'work',
      label: 'Focus',
      duration: formatMinutes(config.workDuration),
    })

    if (i < totalSessions - 1) {
      steps.push({
        type: 'short_break',
        label: 'Break',
        duration: formatMinutes(config.shortBreakDuration),
      })
    } else {
      steps.push({
        type: 'long_break',
        label: 'Long Break',
        duration: formatMinutes(config.longBreakDuration),
      })
    }
  }

  // Calculate current step index
  // sessionCount is the number of completed work sessions
  // If we're in work phase, current step = sessionCount * 2
  // If we're in break phase, current step = sessionCount * 2 + 1
  let currentStepIndex = -1
  if (currentPhase === 'work') {
    currentStepIndex = Math.min(sessionCount * 2, steps.length - 1)
  } else if (currentPhase === 'short_break') {
    currentStepIndex = Math.min(sessionCount * 2 - 1, steps.length - 1)
  } else if (currentPhase === 'long_break') {
    currentStepIndex = steps.length - 1
  }

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {steps.map((step, index) => {
          const isCompleted = index < currentStepIndex
          const isCurrent = index === currentStepIndex
          const isWork = step.type === 'work'
          const isLongBreak = step.type === 'long_break'

          return (
            <div
              key={index}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-xs whitespace-nowrap',
                'transition-all duration-200',
                // Completed steps
                isCompleted && isWork && 'bg-emerald-500/20 text-emerald-500/60',
                isCompleted && !isWork && 'bg-amber-500/20 text-amber-500/60',
                // Current step
                isCurrent && isWork && 'bg-emerald-500/30 text-emerald-400 ring-1 ring-emerald-500/50',
                isCurrent && !isWork && 'bg-amber-500/30 text-amber-400 ring-1 ring-amber-500/50',
                // Future steps
                !isCompleted && !isCurrent && 'bg-gray-800/50 text-gray-500'
              )}
            >
              {isWork ? (
                <Zap className="h-3 w-3" />
              ) : (
                <Coffee className="h-3 w-3" />
              )}
              <span className="font-medium">{step.duration}</span>
              {isLongBreak && <span className="text-[10px] opacity-70">long</span>}
            </div>
          )
        })}
      </div>

      {/* Current status text */}
      {currentPhase && (
        <div className="text-[10px] text-gray-500 text-center">
          {currentPhase === 'work' && `Focus session ${sessionCount + 1} of ${totalSessions}`}
          {currentPhase === 'short_break' && `Break ${sessionCount} of ${totalSessions - 1}`}
          {currentPhase === 'long_break' && 'Long break - cycle complete!'}
        </div>
      )}
    </div>
  )
}
