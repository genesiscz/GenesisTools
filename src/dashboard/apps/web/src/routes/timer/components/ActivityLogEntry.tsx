import { cn } from '@/lib/utils'
import type { ActivityLogEntry as ActivityLogEntryType } from '@dashboard/shared'
import { formatTimeCompact, formatDurationHuman } from '../hooks/useTimerEngine'
import { useSettings } from '@/hooks/useSettings'
import {
  Play,
  Pause,
  RotateCcw,
  Flag,
  CheckCircle2,
  Clock,
  Zap,
  Coffee,
} from 'lucide-react'

interface ActivityLogEntryProps {
  entry: ActivityLogEntryType
  className?: string
}

// Event type config with icons and colors
const EVENT_CONFIG: Record<
  string,
  { icon: React.ElementType; color: string; bgColor: string; label: string }
> = {
  start: {
    icon: Play,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
    label: 'Started',
  },
  pause: {
    icon: Pause,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    label: 'Paused',
  },
  reset: {
    icon: RotateCcw,
    color: 'text-red-400',
    bgColor: 'bg-red-500/10',
    label: 'Reset',
  },
  lap: {
    icon: Flag,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10',
    label: 'Lap',
  },
  complete: {
    icon: CheckCircle2,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    label: 'Completed',
  },
  time_edit: {
    icon: Clock,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    label: 'Time Edited',
  },
  pomodoro_phase_change: {
    icon: Zap,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
    label: 'Phase Change',
  },
}

/**
 * Single activity log entry with cyberpunk timeline styling
 */
export function ActivityLogEntry({ entry, className }: ActivityLogEntryProps) {
  const { settings } = useSettings()
  const config = EVENT_CONFIG[entry.eventType] || {
    icon: Coffee,
    color: 'text-gray-400',
    bgColor: 'bg-gray-500/10',
    label: entry.eventType,
  }

  const Icon = config.icon
  const timestamp = new Date(entry.timestamp)
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: settings.timeFormat === '12h',
  })
  const dateStr = timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' })

  return (
    <div
      className={cn(
        'group relative flex items-center gap-3 py-3 px-4',
        // 'border-l-2 border-gray-700/50',
        // 'hover:border-l-2',
        'hover:bg-gray-800/30',
        'transition-all duration-200',
        className
      )}
    >
      {/* Timeline dot - commented out since we have icons
      <div
        className={cn(
          'absolute -left-[9px] top-4',
          'h-4 w-4 rounded-full',
          'border-2 border-gray-900',
          config.bgColor,
          'flex items-center justify-center',
          'transition-all duration-200',
          'group-hover:scale-110 group-hover:shadow-lg',
          entry.eventType === 'start' && 'group-hover:shadow-emerald-500/30',
          entry.eventType === 'pause' && 'group-hover:shadow-amber-500/30',
          entry.eventType === 'complete' && 'group-hover:shadow-purple-500/30'
        )}
      >
        <div className={cn('h-1.5 w-1.5 rounded-full', config.color.replace('text-', 'bg-'))} />
      </div>
      */}

      {/* Icon container */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-lg',
          config.bgColor,
          'flex items-center justify-center',
          'transition-all duration-200',
          'group-hover:scale-105'
        )}
      >
        <Icon className={cn('h-4 w-4', config.color)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={cn('font-medium text-sm', config.color)}>{config.label}</span>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{timeStr}</span>
            <span className="opacity-50">•</span>
            <span>{dateStr}</span>
          </div>
        </div>

        <div className="mt-1 text-sm text-gray-400 truncate">{entry.timerName}</div>

        {/* Event-specific details */}
        <div className="mt-2 flex flex-wrap gap-2">
          {/* Elapsed time at event */}
          <div
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
              'bg-gray-800/50 text-xs',
              'border border-gray-700/50'
            )}
          >
            <Clock className="h-3 w-3 text-gray-500" />
            <span className="text-gray-400 font-mono">{formatTimeCompact(entry.elapsedAtEvent)}</span>
          </div>

          {/* Session duration (for pause events) */}
          {entry.sessionDuration && (
            <div
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
                'bg-amber-500/10 text-xs',
                'border border-amber-500/20'
              )}
            >
              <span className="text-amber-400/70">Session:</span>
              <span className="text-amber-400 font-mono">{formatDurationHuman(entry.sessionDuration)}</span>
            </div>
          )}

          {/* Lap details */}
          {(entry.metadata as { lapNumber?: number; lapTime?: number } | undefined)?.lapNumber && (
            <div
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
                'bg-cyan-500/10 text-xs',
                'border border-cyan-500/20'
              )}
            >
              <Flag className="h-3 w-3 text-cyan-400" />
              <span className="text-cyan-400">
                Lap #{(entry.metadata as { lapNumber: number }).lapNumber}
              </span>
              {(entry.metadata as { lapTime?: number }).lapTime && (
                <span className="text-cyan-400/70 font-mono">
                  ({formatTimeCompact((entry.metadata as { lapTime: number }).lapTime)})
                </span>
              )}
            </div>
          )}

          {/* Time edit details */}
          {entry.previousValue !== undefined && entry.newValue !== undefined && (
            <div
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
                'bg-blue-500/10 text-xs',
                'border border-blue-500/20'
              )}
            >
              <span className="text-gray-500 font-mono">{formatTimeCompact(entry.previousValue)}</span>
              <span className="text-gray-600">→</span>
              <span className="text-blue-400 font-mono">{formatTimeCompact(entry.newValue)}</span>
            </div>
          )}

          {/* Pomodoro phase */}
          {(entry.metadata as { pomodoroPhase?: string } | undefined)?.pomodoroPhase && (
            <div
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
                'text-xs border',
                (entry.metadata as { pomodoroPhase: string }).pomodoroPhase === 'work'
                  ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
                  : 'bg-green-500/10 border-green-500/20 text-green-400'
              )}
            >
              {(entry.metadata as { pomodoroPhase: string }).pomodoroPhase === 'work' ? (
                <>
                  <Zap className="h-3 w-3" />
                  <span>Work</span>
                </>
              ) : (
                <>
                  <Coffee className="h-3 w-3" />
                  <span>Break</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
