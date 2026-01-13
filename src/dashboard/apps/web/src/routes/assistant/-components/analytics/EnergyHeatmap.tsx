import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { HeatmapCell } from './HeatmapCell'
import type { EnergyHeatmapData } from '@/lib/assistant/lib/storage/types'
import { Loader2 } from 'lucide-react'

interface EnergyHeatmapProps {
  data: EnergyHeatmapData | null
  loading?: boolean
  onCellClick?: (day: number, hour: number) => void
  className?: string
}

/**
 * Day labels for the Y-axis
 */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Hour labels for the X-axis (showing every 3 hours for space)
 */
const HOUR_LABELS = [
  { hour: 0, label: '12a' },
  { hour: 3, label: '3a' },
  { hour: 6, label: '6a' },
  { hour: 9, label: '9a' },
  { hour: 12, label: '12p' },
  { hour: 15, label: '3p' },
  { hour: 18, label: '6p' },
  { hour: 21, label: '9p' },
]

/**
 * Color scale legend items
 */
const LEGEND_ITEMS = [
  { label: '1', color: 'bg-red-900/50' },
  { label: '2', color: 'bg-amber-700/40' },
  { label: '3', color: 'bg-cyan-700/50' },
  { label: '4', color: 'bg-cyan-500/70' },
  { label: '5', color: 'bg-cyan-400' },
]

/**
 * Process heatmap data into a 2D grid structure
 */
function buildGridData(data: EnergyHeatmapData | null): Map<string, {
  focusQuality: number
  count: number
  contextSwitches: number
  tasksCompleted: number
}> {
  const grid = new Map()

  if (!data) return grid

  for (const cell of data.cells) {
    const date = new Date(cell.date)
    const dayOfWeek = date.getDay()
    const key = `${dayOfWeek}-${cell.hour}`

    const existing = grid.get(key)
    if (existing) {
      // Aggregate multiple entries for same day/hour
      const totalCount = existing.count + cell.count
      grid.set(key, {
        focusQuality: (existing.focusQuality * existing.count + cell.focusQuality * cell.count) / totalCount,
        count: totalCount,
        contextSwitches: existing.contextSwitches + (cell.count > 0 ? 1 : 0),
        tasksCompleted: existing.tasksCompleted + (cell.count > 0 ? 1 : 0),
      })
    } else {
      grid.set(key, {
        focusQuality: cell.focusQuality,
        count: cell.count,
        contextSwitches: 0,
        tasksCompleted: 0,
      })
    }
  }

  return grid
}

/**
 * EnergyHeatmap - 7x24 grid visualization of productivity patterns
 *
 * Displays focus quality data across days of week and hours of day.
 * Features cyberpunk aesthetic with neon colors and scanline effects.
 */
export function EnergyHeatmap({
  data,
  loading = false,
  onCellClick,
  className,
}: EnergyHeatmapProps) {
  const [gridData, setGridData] = useState<Map<string, {
    focusQuality: number
    count: number
    contextSwitches: number
    tasksCompleted: number
  }>>(new Map())

  useEffect(() => {
    setGridData(buildGridData(data))
  }, [data])

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center py-12', className)}>
        <Loader2 className="h-8 w-8 text-cyan-500 animate-spin" />
        <span className="ml-3 text-slate-400">Loading energy data...</span>
      </div>
    )
  }

  const peakDay = data?.peakTime?.day ?? -1
  const peakHour = data?.peakTime?.hour ?? -1
  const lowDay = data?.lowTime?.day ?? -1
  const lowHour = data?.lowTime?.hour ?? -1

  return (
    <div className={cn('relative', className)}>
      {/* Scanline overlay effect */}
      <div
        className="pointer-events-none absolute inset-0 z-10 opacity-30"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 255, 255, 0.03) 2px, rgba(0, 255, 255, 0.03) 4px)',
        }}
      />

      {/* Grid container */}
      <div className="relative bg-slate-900/40 rounded-lg border border-cyan-500/20 p-4 overflow-x-auto">
        {/* Hour labels (X-axis) */}
        <div className="flex mb-2 pl-12">
          {HOUR_LABELS.map(({ hour, label }) => (
            <div
              key={hour}
              className="flex-1 text-center text-xs text-slate-500 font-mono"
              style={{ minWidth: '2rem' }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Grid rows */}
        <div className="flex flex-col gap-1">
          {DAY_LABELS.map((dayLabel, dayIndex) => (
            <div key={dayIndex} className="flex items-center gap-2">
              {/* Day label (Y-axis) */}
              <div className="w-10 text-right text-xs text-slate-500 font-mono shrink-0">
                {dayLabel}
              </div>

              {/* Hour cells */}
              <div className="flex-1 grid grid-cols-24 gap-0.5" style={{ minWidth: '24rem' }}>
                {Array.from({ length: 24 }, (_, hourIndex) => {
                  const key = `${dayIndex}-${hourIndex}`
                  const cellData = gridData.get(key)
                  const isPeak = dayIndex === peakDay && hourIndex === peakHour
                  const isLow = dayIndex === lowDay && hourIndex === lowHour

                  return (
                    <HeatmapCell
                      key={key}
                      day={dayIndex}
                      hour={hourIndex}
                      focusQuality={cellData?.focusQuality ?? 0}
                      count={cellData?.count ?? 0}
                      contextSwitches={cellData?.contextSwitches ?? 0}
                      tasksCompleted={cellData?.tasksCompleted ?? 0}
                      isPeak={isPeak}
                      isLow={isLow}
                      onClick={onCellClick ? () => onCellClick(dayIndex, hourIndex) : undefined}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-4 pt-4 border-t border-slate-800/50">
          <span className="text-xs text-slate-500 font-mono">Focus Quality:</span>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-600">Low</span>
            {LEGEND_ITEMS.map((item, i) => (
              <div
                key={i}
                className={cn(
                  'w-4 h-4 rounded-sm border border-cyan-500/20',
                  item.color
                )}
                title={`Quality: ${item.label}`}
              />
            ))}
            <span className="text-xs text-slate-600">High</span>
          </div>
          <div className="flex items-center gap-2 ml-4">
            <div
              className="w-4 h-4 rounded-sm bg-amber-400/60 border border-amber-400/40"
              style={{ boxShadow: '0 0 8px rgba(251, 191, 36, 0.4)' }}
            />
            <span className="text-xs text-amber-400/80">Peak</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * EmptyHeatmap - Displayed when there's no data
 */
export function EmptyHeatmap({ className }: { className?: string }) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center py-12 px-6',
      'bg-slate-900/40 rounded-lg border border-cyan-500/20',
      className
    )}>
      <div className="w-16 h-16 rounded-full bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-cyan-400/60"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-slate-300 mb-2">No Energy Data Yet</h3>
      <p className="text-sm text-slate-500 text-center max-w-xs">
        Start logging your energy levels to see patterns emerge in the heatmap visualization.
      </p>
    </div>
  )
}
