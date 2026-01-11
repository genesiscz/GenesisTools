import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import type { ProductivityStats as ProductivityStatsType } from '@dashboard/shared'
import { getStorageAdapter } from '../lib/storage'
import {
  Clock,
  Zap,
  Target,
  TrendingUp,
  Timer,
  Coffee,
  Flame,
  Award,
} from 'lucide-react'

interface ProductivityStatsProps {
  userId: string | null
  startDate?: Date
  endDate?: Date
  timeRangeLabel?: string
  timerId?: string
  timerNames?: Record<string, string>
  className?: string
}

/**
 * Productivity statistics display with cyberpunk styling
 */
export function ProductivityStats({
  userId,
  startDate,
  endDate,
  timeRangeLabel = 'Today',
  timerId,
  timerNames = {},
  className,
}: ProductivityStatsProps) {
  const [stats, setStats] = useState<ProductivityStatsType | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }

    async function fetchStats() {
      if (!userId) return
      setLoading(true)
      try {
        const adapter = getStorageAdapter()
        const start = startDate || new Date(0)
        const end = endDate || new Date()
        const result = await adapter.getProductivityStats(userId, start, end, timerId)
        setStats(result)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load stats')
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
  }, [userId, startDate?.getTime(), endDate?.getTime(), timerId])

  if (loading) {
    return (
      <div className={cn('p-6 flex items-center justify-center', className)}>
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="h-8 w-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
          <p className="text-sm">Loading stats...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('p-6', className)}>
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className={cn('p-6 text-center text-gray-500', className)}>
        <p className="text-sm">No stats available</p>
      </div>
    )
  }

  // Calculate display values
  const totalHours = Math.floor(stats.totalTimeTracked / 3600000)
  const totalMinutes = Math.floor((stats.totalTimeTracked % 3600000) / 60000)
  const avgSessionMinutes = Math.floor(stats.averageSessionDuration / 60000)
  const longestSessionMinutes = Math.floor(stats.longestSession / 60000)

  // Get timer entries for breakdown
  const timerEntries: [string, number][] = Object.entries(stats.timerBreakdown)

  return (
    <div className={cn('p-4 space-y-4', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="h-5 w-5 text-cyan-400" />
        <h3 className="text-sm font-medium text-gray-300">{timeRangeLabel}</h3>
      </div>

      {/* Main stat cards */}
      <div className="grid grid-cols-2 gap-3">
        {/* Total Time */}
        <StatCard
          icon={Clock}
          label="Total Tracked"
          value={
            totalHours > 0
              ? `${totalHours}h ${totalMinutes}m`
              : `${totalMinutes}m`
          }
          color="cyan"
          highlight
        />

        {/* Sessions */}
        <StatCard
          icon={Timer}
          label="Sessions"
          value={stats.sessionCount.toString()}
          color="amber"
        />

        {/* Avg Session */}
        <StatCard
          icon={Target}
          label="Avg Session"
          value={avgSessionMinutes > 0 ? `${avgSessionMinutes}m` : '< 1m'}
          color="purple"
        />

        {/* Longest */}
        <StatCard
          icon={Flame}
          label="Longest"
          value={longestSessionMinutes > 0 ? `${longestSessionMinutes}m` : '< 1m'}
          color="orange"
        />
      </div>

      {/* Pomodoro stats */}
      {stats.pomodoroCompleted > 0 && (
        <div
          className={cn(
            'p-4 rounded-xl',
            'bg-gradient-to-br from-orange-500/10 to-amber-500/5',
            'border border-orange-500/20'
          )}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-500/20">
              <Coffee className="h-5 w-5 text-orange-400" />
            </div>
            <div>
              <div className="text-sm text-gray-400">Pomodoros Completed</div>
              <div className="text-2xl font-bold text-orange-400 font-mono">
                {stats.pomodoroCompleted}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Timer breakdown - only show when not filtering by a specific timer */}
      {timerEntries.length > 0 && !timerId && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Zap className="h-4 w-4" />
            <span>Time by Timer</span>
          </div>

          <div className="space-y-2">
            {timerEntries
              .sort(([, a], [, b]) => b - a)
              .slice(0, 5)
              .map(([entryTimerId, time]) => {
                const percentage = (time / stats.totalTimeTracked) * 100
                const minutes = Math.floor(time / 60000)
                const hours = Math.floor(minutes / 60)
                const displayTime =
                  hours > 0
                    ? `${hours}h ${minutes % 60}m`
                    : `${minutes}m`

                return (
                  <div key={entryTimerId} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400 truncate max-w-[60%]">
                        {timerNames[entryTimerId] || entryTimerId.slice(0, 8) + '...'}
                      </span>
                      <span className="text-gray-300 font-mono">{displayTime}</span>
                    </div>
                    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          'bg-gradient-to-r from-cyan-500 to-cyan-400',
                          'transition-all duration-500'
                        )}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* Daily breakdown - show only if multiple days */}
      {Object.keys(stats.dailyBreakdown).length > 1 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Award className="h-4 w-4" />
            <span>Daily Activity</span>
          </div>

          <div className="flex items-end gap-1 h-20">
            {(Object.entries(stats.dailyBreakdown) as [string, number][])
              .sort(([a], [b]) => a.localeCompare(b))
              .slice(-7)
              .map(([date, time]) => {
                const maxTime = Math.max(...(Object.values(stats.dailyBreakdown) as number[]))
                const height = maxTime > 0 ? (time / maxTime) * 100 : 0
                const day = new Date(date).toLocaleDateString([], { weekday: 'short' })

                return (
                  <div
                    key={date}
                    className="flex-1 flex flex-col items-center gap-1"
                  >
                    <div className="flex-1 w-full flex items-end">
                      <div
                        className={cn(
                          'w-full rounded-t',
                          'bg-gradient-to-t from-amber-500/50 to-amber-400/30',
                          'transition-all duration-500'
                        )}
                        style={{ height: `${Math.max(height, 4)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500">{day}</span>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {stats.totalTimeTracked === 0 && (
        <div className="text-center py-8">
          <Clock className="h-12 w-12 mx-auto mb-3 text-gray-700" />
          <p className="text-sm text-gray-500">No activity recorded</p>
          <p className="text-xs text-gray-600 mt-1">
            Start tracking to see your stats
          </p>
        </div>
      )}
    </div>
  )
}

interface StatCardProps {
  icon: React.ElementType
  label: string
  value: string
  color: 'cyan' | 'amber' | 'purple' | 'orange' | 'green'
  highlight?: boolean
}

function StatCard({ icon: Icon, label, value, color, highlight }: StatCardProps) {
  const colorClasses = {
    cyan: {
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20',
      text: 'text-cyan-400',
      icon: 'text-cyan-500',
    },
    amber: {
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
      text: 'text-amber-400',
      icon: 'text-amber-500',
    },
    purple: {
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/20',
      text: 'text-purple-400',
      icon: 'text-purple-500',
    },
    orange: {
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/20',
      text: 'text-orange-400',
      icon: 'text-orange-500',
    },
    green: {
      bg: 'bg-green-500/10',
      border: 'border-green-500/20',
      text: 'text-green-400',
      icon: 'text-green-500',
    },
  }

  const classes = colorClasses[color]

  return (
    <div
      className={cn(
        'p-3 rounded-xl',
        'border transition-all duration-200',
        classes.bg,
        classes.border,
        highlight && 'col-span-2'
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn('h-4 w-4', classes.icon)} />
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className={cn('text-xl font-bold font-mono', classes.text)}>{value}</div>
    </div>
  )
}
