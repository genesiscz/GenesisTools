import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { WeeklyReview } from '@/lib/assistant/types'

interface CompletionTrendProps {
  reviews: WeeklyReview[]
  loading?: boolean
}

/**
 * Area chart showing task completion trend over recent weeks
 */
export function CompletionTrend({ reviews, loading }: CompletionTrendProps) {
  if (loading) {
    return <ChartSkeleton />
  }

  // Transform reviews into chart data (oldest first)
  const chartData = [...reviews]
    .reverse()
    .slice(-8) // Last 8 weeks
    .map((review) => {
      const weekStart = new Date(review.weekStart)
      const month = weekStart.toLocaleString('default', { month: 'short' })
      const day = weekStart.getDate()

      return {
        name: `${month} ${day}`,
        tasks: review.tasksCompleted,
        focus: Math.round(review.totalMinutes / 60),
      }
    })

  // If no data, show placeholder
  if (chartData.length === 0) {
    return (
      <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
        <ChartHeader />
        <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
          Complete tasks to see your trend
        </div>
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
      {/* Corner decorations */}
      <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-cyan-500/20 rounded-tl" />
      <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-cyan-500/20 rounded-tr" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-cyan-500/20 rounded-bl" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-cyan-500/20 rounded-br" />

      <ChartHeader />

      <div className="h-[200px] mt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="taskGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.05)"
              vertical={false}
            />
            <XAxis
              dataKey="name"
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
              dy={10}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
              width={30}
              allowDecimals={false}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="tasks"
              stroke="#06b6d4"
              strokeWidth={2}
              fill="url(#taskGradient)"
              dot={{ fill: '#06b6d4', strokeWidth: 0, r: 3 }}
              activeDot={{ r: 5, fill: '#06b6d4', stroke: '#0a0a14', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ChartHeader() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold">Completion Trend</h3>
        <p className="text-xs text-muted-foreground">Tasks completed per week</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-cyan-400" />
        <span className="text-xs text-muted-foreground">Tasks</span>
      </div>
    </div>
  )
}

interface TooltipPayload {
  name: string
  tasks: number
  focus: number
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ payload: TooltipPayload }>
  label?: string
}) {
  if (!active || !payload || !payload.length) return null

  const data = payload[0].payload

  return (
    <div className="bg-[#0a0a14]/95 backdrop-blur-sm border border-cyan-500/20 rounded-lg p-3 shadow-lg">
      <p className="text-xs font-medium text-cyan-400 mb-2">{label}</p>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          <span className="text-white font-medium">{data.tasks}</span> tasks completed
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="text-white font-medium">{data.focus}h</span> focus time
        </p>
      </div>
    </div>
  )
}

function ChartSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="h-4 w-32 bg-white/5 rounded animate-pulse mb-1" />
          <div className="h-3 w-40 bg-white/5 rounded animate-pulse" />
        </div>
      </div>
      <div className="h-[200px] bg-white/5 rounded animate-pulse" />
    </div>
  )
}
