import { CheckCircle, Clock, Flame, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WeeklyReview, Streak } from '@/lib/assistant/types'

interface WeekStatsProps {
  review: WeeklyReview | null
  streak: Streak | null
  comparison: {
    tasksChange: number
    tasksChangePercent: number
    direction: 'up' | 'down' | 'same'
  } | null
  loading?: boolean
}

/**
 * Summary stat cards for weekly review
 */
export function WeekStats({ review, streak, comparison, loading }: WeekStatsProps) {
  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    )
  }

  const focusHours = review ? Math.round(review.totalMinutes / 60 * 10) / 10 : 0
  const deepFocusPercent = review && review.totalMinutes > 0
    ? Math.round((review.deepFocusMinutes / review.totalMinutes) * 100)
    : 0

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {/* Tasks Completed */}
      <StatCard
        icon={CheckCircle}
        iconColor="text-cyan-400"
        iconBg="bg-cyan-500/10"
        label="Tasks Completed"
        value={review?.tasksCompleted ?? 0}
        subValue={
          comparison ? (
            <span className={cn(
              'flex items-center gap-1 text-xs',
              comparison.direction === 'up' && 'text-emerald-400',
              comparison.direction === 'down' && 'text-rose-400',
              comparison.direction === 'same' && 'text-muted-foreground'
            )}>
              {comparison.direction === 'up' && <TrendingUp className="h-3 w-3" />}
              {comparison.direction === 'down' && <TrendingDown className="h-3 w-3" />}
              {comparison.direction === 'same' && <Minus className="h-3 w-3" />}
              {comparison.direction === 'up' && '+'}
              {comparison.tasksChangePercent}% vs last week
            </span>
          ) : null
        }
      />

      {/* Focus Time */}
      <StatCard
        icon={Clock}
        iconColor="text-amber-400"
        iconBg="bg-amber-500/10"
        label="Focus Time"
        value={`${focusHours}h`}
        subValue={
          <span className="text-xs text-muted-foreground">
            {deepFocusPercent}% deep work
          </span>
        }
      />

      {/* Current Streak */}
      <StatCard
        icon={Flame}
        iconColor="text-orange-400"
        iconBg="bg-orange-500/10"
        label="Current Streak"
        value={streak?.currentStreakDays ?? 0}
        subValue={
          streak && streak.longestStreakDays > 0 ? (
            <span className="text-xs text-muted-foreground">
              Best: {streak.longestStreakDays} days
            </span>
          ) : null
        }
        valueClassName={streak && streak.currentStreakDays >= 7 ? 'text-orange-400' : undefined}
      />
    </div>
  )
}

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>
  iconColor: string
  iconBg: string
  label: string
  value: string | number
  subValue?: React.ReactNode
  valueClassName?: string
}

function StatCard({
  icon: Icon,
  iconColor,
  iconBg,
  label,
  value,
  subValue,
  valueClassName,
}: StatCardProps) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
      {/* Corner decorations */}
      <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-white/10 rounded-tl" />
      <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-white/10 rounded-tr" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-white/10 rounded-bl" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-white/10 rounded-br" />

      <div className="flex items-start gap-3">
        <div className={cn('p-2 rounded-lg', iconBg)}>
          <Icon className={cn('h-5 w-5', iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            {label}
          </p>
          <p className={cn('text-2xl font-bold tracking-tight', valueClassName)}>
            {value}
          </p>
          {subValue && <div className="mt-1">{subValue}</div>}
        </div>
      </div>
    </div>
  )
}

function StatCardSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-white/5 animate-pulse" />
        <div className="flex-1">
          <div className="h-3 w-16 bg-white/5 rounded animate-pulse mb-2" />
          <div className="h-7 w-12 bg-white/5 rounded animate-pulse mb-1" />
          <div className="h-3 w-20 bg-white/5 rounded animate-pulse" />
        </div>
      </div>
    </div>
  )
}
