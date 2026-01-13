import { useState, useEffect } from 'react'
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from 'recharts'
import {
  MessageSquare,
  Mail,
  Users,
  User,
  Coffee,
  AlertCircle,
  TrendingDown,
  TrendingUp,
  Minus,
  Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import type { DistractionSource } from '@/lib/assistant/types'
import type { DistractionStats as DistractionStatsType } from '@/lib/assistant/lib/storage/types'

interface DistractionStatsProps {
  stats: DistractionStatsType | null
  trend: 'improving' | 'worsening' | 'stable'
  loading?: boolean
  className?: string
}

/**
 * Color configuration for each distraction source
 */
const sourceColors: Record<DistractionSource, { fill: string; glow: string }> = {
  slack: { fill: '#06b6d4', glow: 'rgba(6, 182, 212, 0.5)' },
  email: { fill: '#3b82f6', glow: 'rgba(59, 130, 246, 0.5)' },
  meeting: { fill: '#f97316', glow: 'rgba(249, 115, 22, 0.5)' },
  coworker: { fill: '#a855f7', glow: 'rgba(168, 85, 247, 0.5)' },
  hunger: { fill: '#f59e0b', glow: 'rgba(245, 158, 11, 0.5)' },
  other: { fill: '#6b7280', glow: 'rgba(107, 114, 128, 0.5)' },
}

const sourceIcons: Record<DistractionSource, typeof MessageSquare> = {
  slack: MessageSquare,
  email: Mail,
  meeting: Users,
  coworker: User,
  hunger: Coffee,
  other: AlertCircle,
}

const sourceLabels: Record<DistractionSource, string> = {
  slack: 'Slack/Chat',
  email: 'Email',
  meeting: 'Meeting',
  coworker: 'Coworker',
  hunger: 'Hunger/Break',
  other: 'Other',
}

/**
 * Custom tooltip for pie chart
 */
function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{
    name: string
    value: number
    payload: { source: DistractionSource; count: number; duration: number; percentage: number }
  }>
}) {
  if (!active || !payload?.[0]) return null

  const data = payload[0].payload
  const Icon = sourceIcons[data.source]

  return (
    <div className="bg-[#0a0a14]/95 border border-white/10 rounded-lg p-3 shadow-xl">
      <div className="flex items-center gap-2 mb-2">
        <Icon
          className="h-4 w-4"
          style={{ color: sourceColors[data.source].fill }}
        />
        <span className="font-medium">{sourceLabels[data.source]}</span>
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{data.count}</span> interruptions
        </p>
        <p>
          <span className="font-medium text-foreground">{data.percentage.toFixed(1)}%</span> of total
        </p>
        {data.duration > 0 && (
          <p>
            <span className="font-medium text-foreground">{data.duration}</span> min lost
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * DistractionStats - Pie chart showing distraction distribution
 *
 * Features:
 * - Neon glow effect on chart segments
 * - Trend indicator (improving/worsening/stable)
 * - Total count and time lost summary
 */
export function DistractionStats({
  stats,
  trend,
  loading = false,
  className,
}: DistractionStatsProps) {
  const [chartData, setChartData] = useState<
    Array<{
      source: DistractionSource
      count: number
      duration: number
      percentage: number
    }>
  >([])

  // Transform stats into chart data
  useEffect(() => {
    if (!stats?.bySource) {
      setChartData([])
      return
    }

    const total = stats.totalDistractions || 1
    const data = Object.entries(stats.bySource)
      .map(([source, values]) => ({
        source: source as DistractionSource,
        count: values.count,
        duration: values.duration,
        percentage: (values.count / total) * 100,
      }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count)

    setChartData(data)
  }, [stats])

  const TrendIcon = trend === 'improving' ? TrendingDown : trend === 'worsening' ? TrendingUp : Minus

  if (loading) {
    return (
      <FeatureCard color="cyan" className={className}>
        <FeatureCardHeader>
          <h3 className="text-lg font-semibold">Distraction Sources</h3>
        </FeatureCardHeader>
        <FeatureCardContent>
          <div className="h-64 flex items-center justify-center">
            <div className="animate-pulse text-muted-foreground">Loading...</div>
          </div>
        </FeatureCardContent>
      </FeatureCard>
    )
  }

  if (chartData.length === 0) {
    return (
      <FeatureCard color="cyan" className={className}>
        <FeatureCardHeader>
          <h3 className="text-lg font-semibold">Distraction Sources</h3>
        </FeatureCardHeader>
        <FeatureCardContent>
          <div className="h-64 flex flex-col items-center justify-center text-muted-foreground">
            <AlertCircle className="h-12 w-12 mb-4 opacity-50" />
            <p>No distractions logged yet</p>
            <p className="text-sm mt-1">Use the quick log button to track interruptions</p>
          </div>
        </FeatureCardContent>
      </FeatureCard>
    )
  }

  return (
    <FeatureCard color="cyan" className={className}>
      <FeatureCardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Distraction Sources</h3>
          <div
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium',
              trend === 'improving'
                ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : trend === 'worsening'
                  ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-gray-500/10 text-gray-400 border border-gray-500/20'
            )}
          >
            <TrendIcon className="h-3 w-3" />
            {trend === 'improving' ? 'Improving' : trend === 'worsening' ? 'Worsening' : 'Stable'}
          </div>
        </div>
      </FeatureCardHeader>

      <FeatureCardContent>
        {/* Summary stats */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="p-3 rounded-lg bg-white/5 border border-white/10">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <AlertCircle className="h-4 w-4" />
              <span className="text-xs">Total Interruptions</span>
            </div>
            <p className="text-2xl font-bold text-cyan-400">
              {stats?.totalDistractions ?? 0}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-white/5 border border-white/10">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Clock className="h-4 w-4" />
              <span className="text-xs">Time Lost</span>
            </div>
            <p className="text-2xl font-bold text-orange-400">
              {stats?.totalDurationMinutes
                ? stats.totalDurationMinutes < 60
                  ? `${stats.totalDurationMinutes}m`
                  : `${Math.floor(stats.totalDurationMinutes / 60)}h ${stats.totalDurationMinutes % 60}m`
                : '0m'}
            </p>
          </div>
        </div>

        {/* Pie chart */}
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <defs>
                {chartData.map((entry) => (
                  <filter
                    key={`glow-${entry.source}`}
                    id={`glow-${entry.source}`}
                    x="-50%"
                    y="-50%"
                    width="200%"
                    height="200%"
                  >
                    <feGaussianBlur
                      stdDeviation="3"
                      result="coloredBlur"
                    />
                    <feMerge>
                      <feMergeNode in="coloredBlur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                ))}
              </defs>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={2}
                dataKey="count"
                nameKey="source"
              >
                {chartData.map((entry) => (
                  <Cell
                    key={entry.source}
                    fill={sourceColors[entry.source].fill}
                    stroke={sourceColors[entry.source].fill}
                    strokeWidth={2}
                    style={{
                      filter: `drop-shadow(0 0 6px ${sourceColors[entry.source].glow})`,
                    }}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend
                formatter={(value: DistractionSource) => (
                  <span className="text-sm text-muted-foreground">
                    {sourceLabels[value]}
                  </span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Top distraction callout */}
        {stats?.mostCommonSource && (
          <div className="mt-4 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
            <p className="text-sm">
              <span className="font-semibold text-cyan-400">
                {sourceLabels[stats.mostCommonSource as DistractionSource]}
              </span>{' '}
              is your #1 distraction source
              {stats.bySource[stats.mostCommonSource] && (
                <span className="text-muted-foreground">
                  {' '}
                  ({Math.round((stats.bySource[stats.mostCommonSource].count / stats.totalDistractions) * 100)}% of all interruptions)
                </span>
              )}
            </p>
          </div>
        )}
      </FeatureCardContent>
    </FeatureCard>
  )
}
