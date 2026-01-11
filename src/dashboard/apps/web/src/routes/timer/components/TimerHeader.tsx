import { memo } from 'react'
import { Plus, Activity, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TimerHeaderProps {
  timerCount: number
  runningCount: number
  onAddTimer: () => void
  onToggleActivityLog?: () => void
  showActivityLog?: boolean
  className?: string
}

/**
 * Timer page header with cyberpunk terminal styling
 */
export const TimerHeader = memo(function TimerHeader({
  timerCount,
  runningCount,
  onAddTimer,
  onToggleActivityLog,
  showActivityLog,
  className,
}: TimerHeaderProps) {
  return (
    <header
      className={cn(
        'relative z-20',
        'border-b border-amber-500/20',
        'bg-black/60 backdrop-blur-xl',
        className
      )}
    >
      {/* Decorative top line */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-amber-500/50 to-transparent" />

      <div className="container mx-auto px-6 py-5">
        <div className="flex items-center justify-between gap-6">
          {/* Title section */}
          <div className="flex items-center gap-4">
            {/* Logo/Icon */}
            <div
              className={cn(
                'flex items-center justify-center',
                'w-12 h-12 rounded-xl',
                'bg-gradient-to-br from-amber-500/20 to-amber-600/10',
                'border border-amber-500/30',
                'shadow-[0_0_20px_rgba(255,149,0,0.2)]'
              )}
            >
              <Zap className="h-6 w-6 text-amber-400" />
            </div>

            <div>
              {/* Title with gradient */}
              <h1
                className={cn(
                  'text-2xl font-bold tracking-tight',
                  'bg-gradient-to-r from-amber-400 via-amber-200 to-cyan-400',
                  'bg-clip-text text-transparent'
                )}
                style={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                }}
              >
                CHRONO <span className="text-amber-500/60">//</span> TERMINAL
              </h1>

              {/* Status line */}
              <div className="flex items-center gap-4 mt-1">
                <span className="text-xs text-gray-500 font-mono">
                  {timerCount === 0 ? (
                    'No active timers'
                  ) : (
                    <>
                      <span className="text-gray-400">{timerCount}</span>
                      {' '}timer{timerCount !== 1 ? 's' : ''}
                    </>
                  )}
                </span>

                {runningCount > 0 && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                    <span className="font-mono">{runningCount} running</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            {/* Activity log toggle */}
            {onToggleActivityLog && (
              <button
                onClick={onToggleActivityLog}
                className={cn(
                  'flex items-center gap-2 px-4 py-2.5 rounded-xl',
                  'text-sm font-medium transition-all duration-300',
                  'border',
                  showActivityLog
                    ? [
                        'bg-cyan-500/20 text-cyan-400',
                        'border-cyan-500/40',
                        'shadow-[0_0_15px_rgba(0,240,255,0.2)]',
                      ]
                    : [
                        'bg-transparent text-gray-400',
                        'border-gray-700 hover:border-gray-600',
                        'hover:bg-gray-800/50 hover:text-gray-300',
                      ]
                )}
              >
                <Activity className="h-4 w-4" />
                <span className="hidden sm:inline">Activity</span>
              </button>
            )}

            {/* Add timer button */}
            <button
              onClick={onAddTimer}
              className={cn(
                'group relative flex items-center gap-2 px-5 py-2.5 rounded-xl',
                'font-semibold text-sm text-black',
                'bg-gradient-to-br from-amber-400 to-amber-500',
                'shadow-[0_0_25px_rgba(255,149,0,0.4)]',
                'transition-all duration-300',
                'hover:shadow-[0_0_35px_rgba(255,149,0,0.6)]',
                'hover:scale-[1.02] active:scale-[0.98]',
                'overflow-hidden'
              )}
            >
              {/* Shimmer effect */}
              <div
                className={cn(
                  'absolute inset-0 opacity-0 group-hover:opacity-100',
                  'bg-gradient-to-r from-transparent via-white/30 to-transparent',
                  'translate-x-[-100%] group-hover:translate-x-[100%]',
                  'transition-transform duration-500 ease-out'
                )}
              />

              <Plus className="h-5 w-5 relative z-10" />
              <span className="relative z-10 hidden sm:inline">Add Timer</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  )
})
