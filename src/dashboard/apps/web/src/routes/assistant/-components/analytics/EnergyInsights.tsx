import { cn } from '@/lib/utils'
import { TrendingUp, TrendingDown, Minus, Zap, Moon, Calendar, Activity } from 'lucide-react'
import type { EnergyHeatmapData } from '@/lib/assistant/lib/storage/types'
import type { EnergySnapshot } from '@/lib/assistant/types'

interface EnergyInsightsProps {
  data: EnergyHeatmapData | null
  snapshots: EnergySnapshot[]
  trend: 'improving' | 'declining' | 'stable'
  averageFocusQuality: number
  totalContextSwitches: number
  className?: string
}

/**
 * Day names for display
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Format hour to readable string
 */
function formatHourRange(hour: number): string {
  const startHour = hour
  const endHour = (hour + 1) % 24
  const formatSingle = (h: number) => {
    if (h === 0) return '12am'
    if (h === 12) return '12pm'
    if (h < 12) return `${h}am`
    return `${h - 12}pm`
  }
  return `${formatSingle(startHour)}-${formatSingle(endHour)}`
}

/**
 * Get peak focus time range description
 */
function getPeakTimeDescription(data: EnergyHeatmapData | null): string {
  if (!data || !data.peakTime) return 'Not enough data'

  // Find consecutive peak hours
  const peakHour = data.peakTime.hour
  const hourlyAvgs = data.hourlyAverages
  const threshold = data.peakTime.quality * 0.9

  let startHour = peakHour
  let endHour = peakHour

  // Expand backward
  while (startHour > 0 && (hourlyAvgs[startHour - 1] ?? 0) >= threshold) {
    startHour--
  }

  // Expand forward
  while (endHour < 23 && (hourlyAvgs[endHour + 1] ?? 0) >= threshold) {
    endHour++
  }

  const formatHour = (h: number) => {
    if (h === 0) return '12am'
    if (h === 12) return '12pm'
    if (h < 12) return `${h}am`
    return `${h - 12}pm`
  }

  return `${formatHour(startHour)}-${formatHour(endHour + 1)}`
}

/**
 * Get low energy time description
 */
function getLowTimeDescription(data: EnergyHeatmapData | null): string {
  if (!data || !data.lowTime) return 'Not enough data'

  const lowHour = data.lowTime.hour

  // Check if it's afternoon slump (1pm-4pm range)
  if (lowHour >= 13 && lowHour <= 16) {
    return `Afternoon slump: ${formatHourRange(lowHour)}`
  }

  return formatHourRange(lowHour)
}

/**
 * Get best day description
 */
function getBestDayDescription(data: EnergyHeatmapData | null): string {
  if (!data) return 'Not enough data'

  const dailyAvgs = data.dailyAverages
  let bestDay = 0
  let bestAvg = 0

  for (let day = 0; day < 7; day++) {
    const avg = dailyAvgs[day] ?? 0
    if (avg > bestAvg) {
      bestAvg = avg
      bestDay = day
    }
  }

  if (bestAvg === 0) return 'Not enough data'

  return DAY_NAMES[bestDay]
}

/**
 * Insight card component
 */
function InsightCard({
  icon: Icon,
  label,
  value,
  subtext,
  color = 'cyan',
  className,
}: {
  icon: React.ElementType
  label: string
  value: string
  subtext?: string
  color?: 'cyan' | 'amber' | 'red' | 'green' | 'purple'
  className?: string
}) {
  const colorClasses = {
    cyan: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    red: 'text-red-400 bg-red-500/10 border-red-500/20',
    green: 'text-green-400 bg-green-500/10 border-green-500/20',
    purple: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  }

  const iconColors = {
    cyan: 'text-cyan-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    green: 'text-green-400',
    purple: 'text-purple-400',
  }

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        colorClasses[color],
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn('p-2 rounded-md bg-slate-900/50', iconColors[color])}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-slate-500 uppercase tracking-wider font-mono mb-1">
            {label}
          </p>
          <p className={cn('font-semibold truncate', iconColors[color])}>
            {value}
          </p>
          {subtext && (
            <p className="text-xs text-slate-500 mt-1">{subtext}</p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * EnergyInsights - Pattern analysis panel
 *
 * Displays key insights derived from energy data including:
 * - Peak focus times
 * - Low energy periods (afternoon slump)
 * - Best performing days
 * - Overall trends
 */
export function EnergyInsights({
  data,
  snapshots,
  trend,
  averageFocusQuality,
  totalContextSwitches,
  className,
}: EnergyInsightsProps) {
  const hasData = snapshots.length > 0

  const TrendIcon = trend === 'improving' ? TrendingUp : trend === 'declining' ? TrendingDown : Minus
  const trendColor = trend === 'improving' ? 'green' : trend === 'declining' ? 'red' : 'cyan'
  const trendText = trend === 'improving' ? 'Improving' : trend === 'declining' ? 'Declining' : 'Stable'

  const peakTime = getPeakTimeDescription(data)
  const lowTime = getLowTimeDescription(data)
  const bestDay = getBestDayDescription(data)

  // Calculate weekly summary
  const thisWeekSnapshots = snapshots.filter(s => {
    const snapshotDate = new Date(s.timestamp)
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    return snapshotDate >= weekAgo
  })

  const weeklyLogCount = thisWeekSnapshots.length

  return (
    <div className={cn('space-y-4', className)}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <Activity className="h-5 w-5 text-purple-400" />
        <h3 className="font-semibold text-slate-200">Productivity Insights</h3>
      </div>

      {!hasData ? (
        <div className="text-center py-8 text-slate-500">
          <p>Log your energy levels to see insights</p>
        </div>
      ) : (
        <>
          {/* Main insights grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <InsightCard
              icon={Zap}
              label="Peak Focus"
              value={peakTime}
              subtext={data?.peakTime ? `Quality: ${data.peakTime.quality.toFixed(1)}/5` : undefined}
              color="amber"
            />

            <InsightCard
              icon={Moon}
              label="Low Energy"
              value={lowTime}
              subtext={data?.lowTime ? `Quality: ${data.lowTime.quality.toFixed(1)}/5` : undefined}
              color="red"
            />

            <InsightCard
              icon={Calendar}
              label="Best Day"
              value={bestDay}
              subtext="Highest average focus"
              color="green"
            />

            <InsightCard
              icon={TrendIcon}
              label="Trend"
              value={trendText}
              subtext={`Avg: ${averageFocusQuality.toFixed(1)}/5`}
              color={trendColor}
            />
          </div>

          {/* Summary stats */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-700/30 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-cyan-400">{weeklyLogCount}</p>
                <p className="text-xs text-slate-500">Logs this week</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-amber-400">{totalContextSwitches}</p>
                <p className="text-xs text-slate-500">Context switches</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-purple-400">{snapshots.length}</p>
                <p className="text-xs text-slate-500">Total snapshots</p>
              </div>
            </div>
          </div>

          {/* Recommendations text */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-400">Recommendations</h4>
            <ul className="space-y-1.5 text-sm text-slate-500">
              {data?.peakTime && (
                <li className="flex items-start gap-2">
                  <span className="text-cyan-400">-</span>
                  <span>Schedule complex tasks during your peak hours ({peakTime})</span>
                </li>
              )}
              {data?.lowTime && lowTime.includes('Afternoon') && (
                <li className="flex items-start gap-2">
                  <span className="text-cyan-400">-</span>
                  <span>Consider a short break or lighter tasks during your afternoon slump</span>
                </li>
              )}
              {totalContextSwitches > 20 && (
                <li className="flex items-start gap-2">
                  <span className="text-cyan-400">-</span>
                  <span>High context switches detected. Try time-blocking to reduce interruptions</span>
                </li>
              )}
              {trend === 'declining' && (
                <li className="flex items-start gap-2">
                  <span className="text-cyan-400">-</span>
                  <span>Focus quality is declining. Consider reviewing your work habits</span>
                </li>
              )}
              {trend === 'improving' && (
                <li className="flex items-start gap-2">
                  <span className="text-cyan-400">-</span>
                  <span>Great progress! Your focus patterns are improving</span>
                </li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
