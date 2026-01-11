import { memo, useMemo, useState } from 'react'
import { Trash2, ChevronDown, ChevronUp, Trophy, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTimeCompact } from '../hooks/useTimerEngine'
import type { LapEntry } from '@dashboard/shared'

interface LapsListProps {
  laps: LapEntry[]
  onClear?: () => void
  maxVisible?: number
  className?: string
}

/**
 * Lap recordings display with cyberpunk terminal styling
 */
export const LapsList = memo(function LapsList({
  laps,
  onClear,
  maxVisible = 5,
  className,
}: LapsListProps) {
  const [expanded, setExpanded] = useState(false)

  // Find best and worst laps (excluding first lap)
  const { bestLapIndex, worstLapIndex } = useMemo(() => {
    if (laps.length <= 1) return { bestLapIndex: -1, worstLapIndex: -1 }

    const comparableLaps = laps.slice(1)
    if (comparableLaps.length === 0) return { bestLapIndex: -1, worstLapIndex: -1 }

    let best = 0
    let worst = 0

    comparableLaps.forEach((lap, i) => {
      if (lap.lapTime < comparableLaps[best].lapTime) best = i
      if (lap.lapTime > comparableLaps[worst].lapTime) worst = i
    })

    return {
      bestLapIndex: best + 1,
      worstLapIndex: worst + 1,
    }
  }, [laps])

  // Reverse to show most recent first
  const displayLaps = useMemo(() => {
    const reversed = [...laps].reverse()
    return expanded ? reversed : reversed.slice(0, maxVisible)
  }, [laps, maxVisible, expanded])

  const hasMoreLaps = laps.length > maxVisible

  if (laps.length === 0) return null

  return (
    <div className={cn('', className)}>
      {/* Header with terminal styling */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-cyan-500/70">{'>'}</span>
          <span className="text-xs uppercase tracking-[0.2em] text-gray-400 font-medium">
            Lap Records
          </span>
          <span className="text-xs font-mono text-cyan-400/60 tabular-nums">
            [{laps.length.toString().padStart(2, '0')}]
          </span>
        </div>
        {onClear && laps.length > 0 && (
          <button
            onClick={onClear}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-lg',
              'text-xs text-gray-500 hover:text-red-400',
              'bg-transparent hover:bg-red-500/10',
              'border border-transparent hover:border-red-500/30',
              'transition-all duration-200'
            )}
          >
            <Trash2 className="h-3 w-3" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Laps list with scan line effect */}
      <div
        className={cn(
          'relative rounded-xl overflow-hidden',
          'border border-cyan-500/20 bg-black/40',
          'max-h-52 overflow-y-auto cyberpunk-scrollbar'
        )}
      >
        {/* Subtle scan line overlay */}
        <div className="absolute inset-0 pointer-events-none opacity-5 z-10">
          <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,240,255,0.1)_2px,rgba(0,240,255,0.1)_4px)]" />
        </div>

        <div className="relative z-0 divide-y divide-cyan-500/10">
          {displayLaps.map((lap, displayIndex) => {
            const originalIndex = laps.length - 1 - displayIndex
            const isBest = originalIndex === bestLapIndex
            const isWorst = originalIndex === worstLapIndex
            const isRecent = displayIndex === 0

            return (
              <div
                key={lap.number}
                className={cn(
                  'flex items-center justify-between py-3 px-4',
                  'transition-all duration-200',
                  isRecent && 'bg-cyan-500/5',
                  isBest && 'bg-emerald-500/10',
                  isWorst && 'bg-red-500/5'
                )}
              >
                {/* Left: Lap number and time */}
                <div className="flex items-center gap-4">
                  {/* Lap number badge */}
                  <span
                    className={cn(
                      'flex items-center justify-center',
                      'w-8 h-8 rounded-lg',
                      'text-xs font-mono font-bold',
                      'border transition-colors',
                      isBest && 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400',
                      isWorst && 'bg-red-500/10 border-red-500/30 text-red-400',
                      !isBest && !isWorst && 'bg-gray-800/50 border-gray-700/50 text-gray-400'
                    )}
                  >
                    {lap.number}
                  </span>

                  {/* Lap time */}
                  <div className="flex flex-col">
                    <span
                      className={cn(
                        'font-mono text-base tabular-nums',
                        isBest && 'text-emerald-400',
                        isWorst && 'text-red-400',
                        !isBest && !isWorst && 'text-white'
                      )}
                      style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    >
                      {formatTimeCompact(lap.lapTime)}
                    </span>

                    {/* Best/Worst indicator */}
                    {(isBest || isWorst) && (
                      <span
                        className={cn(
                          'flex items-center gap-1 text-[10px] uppercase tracking-wider mt-0.5',
                          isBest && 'text-emerald-400/70',
                          isWorst && 'text-red-400/70'
                        )}
                      >
                        {isBest && (
                          <>
                            <Trophy className="h-2.5 w-2.5" />
                            <span>Best</span>
                          </>
                        )}
                        {isWorst && (
                          <>
                            <Zap className="h-2.5 w-2.5" />
                            <span>Slowest</span>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right: Split time */}
                <div className="text-right">
                  <span className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">
                    Split
                  </span>
                  <span className="font-mono text-sm text-gray-400 tabular-nums">
                    {formatTimeCompact(lap.splitTime)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Expand/collapse button */}
      {hasMoreLaps && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'w-full mt-2 py-2 rounded-lg',
            'flex items-center justify-center gap-2',
            'text-xs text-cyan-400/60 hover:text-cyan-400',
            'bg-cyan-500/5 hover:bg-cyan-500/10',
            'border border-cyan-500/20 hover:border-cyan-500/40',
            'transition-all duration-200'
          )}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              <span>Show less</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              <span>Show {laps.length - maxVisible} more</span>
            </>
          )}
        </button>
      )}
    </div>
  )
})
