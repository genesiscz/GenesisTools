import { memo, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { TimerType } from '@dashboard/shared'

interface TimerDisplayProps {
  time: string
  isRunning: boolean
  timerType: TimerType
  isCompleted?: boolean
  className?: string
}

/**
 * Cyberpunk neon timer display with CRT effects
 */
export const TimerDisplay = memo(function TimerDisplay({
  time,
  isRunning,
  timerType,
  isCompleted,
  className,
}: TimerDisplayProps) {
  // Subtle glitch effect on completion
  const [glitching, setGlitching] = useState(false)

  useEffect(() => {
    if (isCompleted) {
      setGlitching(true)
      const timeout = setTimeout(() => setGlitching(false), 500)
      return () => clearTimeout(timeout)
    }
  }, [isCompleted])

  // Split time into segments for individual styling
  const segments = time.split(/([:.])/)

  // Color scheme based on timer type
  const colorScheme = {
    stopwatch: {
      text: 'text-cyan-400',
      glow: 'drop-shadow-[0_0_10px_rgba(0,240,255,0.5)] drop-shadow-[0_0_30px_rgba(0,240,255,0.3)]',
      separator: 'text-cyan-600',
    },
    countdown: {
      text: 'text-amber-400',
      glow: 'drop-shadow-[0_0_10px_rgba(255,149,0,0.5)] drop-shadow-[0_0_30px_rgba(255,149,0,0.3)]',
      separator: 'text-amber-600',
    },
    pomodoro: {
      text: 'text-emerald-400',
      glow: 'drop-shadow-[0_0_10px_rgba(52,211,153,0.5)] drop-shadow-[0_0_30px_rgba(52,211,153,0.3)]',
      separator: 'text-emerald-600',
    },
  }[timerType]

  return (
    <div
      className={cn(
        'relative font-mono text-center select-none transition-all duration-300',
        'py-4',
        glitching && 'glitch-effect',
        className
      )}
    >
      {/* CRT scanline overlay - subtle */}
      <div className="absolute inset-0 pointer-events-none opacity-5">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,0,0,0.2)_2px,rgba(0,0,0,0.2)_4px)]" />
      </div>

      {/* Time display - removed pulse-glow animation that caused weird glow when running */}
      <div
        className={cn(
          'inline-flex items-baseline justify-center',
          'text-5xl sm:text-6xl md:text-7xl font-bold tracking-tighter',
          colorScheme.text,
          colorScheme.glow,
          isCompleted && 'animate-[flash_0.5s_ease-in-out_3]'
        )}
        style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {segments.map((segment, i) => {
          const isSeparator = /[.:]/.test(segment)
          const isMilliseconds = i === segments.length - 1 && segments.length > 3

          return (
            <span
              key={i}
              className={cn(
                'transition-all duration-150',
                isSeparator && [
                  'text-3xl sm:text-4xl md:text-5xl mx-0.5',
                  colorScheme.separator,
                  'opacity-60',
                ],
                isMilliseconds && 'text-3xl sm:text-4xl md:text-5xl opacity-70 ml-0.5'
              )}
            >
              {segment}
            </span>
          )
        })}
      </div>

      {/* Active indicator moved to TimerCard header - removed from here to prevent height jump */}

      {/* Completed indicator */}
      {isCompleted && !isRunning && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <span className="text-sm uppercase tracking-[0.2em] text-amber-400 font-bold animate-pulse">
            ▶ Complete ◀
          </span>
        </div>
      )}
    </div>
  )
})
