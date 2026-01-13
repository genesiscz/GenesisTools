import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import type { WeeklyReview } from '@/lib/assistant/types'

interface DeadlinePerformanceProps {
  review: WeeklyReview | null
  loading?: boolean
}

const COLORS = {
  onTime: '#f59e0b', // amber
  late: '#f43f5e', // rose
}

/**
 * Donut chart showing deadline performance (on-time vs late)
 */
export function DeadlinePerformance({ review, loading }: DeadlinePerformanceProps) {
  if (loading) {
    return <ChartSkeleton />
  }

  const deadlinesHit = review?.deadlinesHit ?? 0
  const deadlinesTotal = review?.deadlinesTotal ?? 0
  const deadlinesMissed = deadlinesTotal - deadlinesHit

  const hitRate = deadlinesTotal > 0
    ? Math.round((deadlinesHit / deadlinesTotal) * 100)
    : 0

  const chartData = [
    { name: 'On Time', value: deadlinesHit, color: COLORS.onTime },
    { name: 'Late', value: deadlinesMissed, color: COLORS.late },
  ]

  // If no deadlines, show placeholder
  if (deadlinesTotal === 0) {
    return (
      <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4 h-full">
        <ChartHeader total={0} />
        <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">
          No deadlines tracked yet
        </div>
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4 h-full">
      {/* Corner decorations */}
      <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-amber-500/20 rounded-tl" />
      <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-amber-500/20 rounded-tr" />
      <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-amber-500/20 rounded-bl" />
      <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-amber-500/20 rounded-br" />

      <ChartHeader total={deadlinesTotal} />

      <div className="h-[180px] mt-2 relative">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={75}
              paddingAngle={2}
              dataKey="value"
              stroke="none"
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip total={deadlinesTotal} />} />
          </PieChart>
        </ResponsiveContainer>

        {/* Center label */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-2xl font-bold text-amber-400">{hitRate}%</p>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
              On Time
            </p>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex justify-center gap-6 mt-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-xs text-muted-foreground">On Time ({deadlinesHit})</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-rose-500" />
          <span className="text-xs text-muted-foreground">Late ({deadlinesMissed})</span>
        </div>
      </div>
    </div>
  )
}

function ChartHeader({ total }: { total: number }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">Deadline Performance</h3>
      <p className="text-xs text-muted-foreground">
        {total > 0 ? `${total} deadline${total !== 1 ? 's' : ''} tracked` : 'Track deadlines to see stats'}
      </p>
    </div>
  )
}

interface TooltipPayload {
  name: string
  value: number
  color: string
}

function CustomTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean
  payload?: Array<{ payload: TooltipPayload }>
  total: number
}) {
  if (!active || !payload || !payload.length) return null

  const data = payload[0].payload
  const percent = total > 0 ? Math.round((data.value / total) * 100) : 0

  return (
    <div className="bg-[#0a0a14]/95 backdrop-blur-sm border border-amber-500/20 rounded-lg p-3 shadow-lg">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: data.color }}
        />
        <span className="text-xs font-medium" style={{ color: data.color }}>
          {data.name}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="text-white font-medium">{data.value}</span> deadline
        {data.value !== 1 ? 's' : ''} ({percent}%)
      </p>
    </div>
  )
}

function ChartSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4 h-full">
      <div className="mb-4">
        <div className="h-4 w-36 bg-white/5 rounded animate-pulse mb-1" />
        <div className="h-3 w-24 bg-white/5 rounded animate-pulse" />
      </div>
      <div className="h-[180px] flex items-center justify-center">
        <div className="h-[140px] w-[140px] rounded-full bg-white/5 animate-pulse" />
      </div>
    </div>
  )
}
