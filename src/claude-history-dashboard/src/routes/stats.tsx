import { Suspense, useState } from 'react'
import { createFileRoute, Link, Await, defer } from '@tanstack/react-router'
import { getQuickStats, getFullStats, getStatsInRange, type QuickStatsResponse, type SerializableStats } from '@/server/conversations'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, MessageSquare, FolderOpen, Wrench, Activity, Bot, TrendingUp, RefreshCw, Calendar, Coins, Filter } from 'lucide-react'
import { ActivityChartSkeleton } from '@/components/stats/ChartSkeleton'
import { ProjectListSkeleton, ToolBadgesSkeleton } from '@/components/stats/ProjectListSkeleton'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { HourlyHeatmap } from '@/components/stats/HourlyHeatmap'
import { ToolCategoriesChart } from '@/components/stats/ToolCategoriesChart'
import { TokenUsageCard } from '@/components/stats/TokenUsageCard'
import { ModelUsageChart } from '@/components/stats/ModelUsageChart'
import { CumulativeChart } from '@/components/stats/CumulativeChart'
import { WeeklyTrendsCard } from '@/components/stats/WeeklyTrendsCard'
import { BranchActivityChart } from '@/components/stats/BranchActivityChart'
import { ConversationLengthHistogram } from '@/components/stats/ConversationLengthHistogram'
import { Skeleton } from '@/components/ui/skeleton'

export const Route = createFileRoute('/stats')({
  component: StatsPage,
  loader: async () => {
    // Quick stats load immediately (from cache)
    const quickStats = await getQuickStats()

    // Full stats deferred (stream in background)
    return {
      quickStats,
      fullStats: defer(getFullStats({ data: { forceRefresh: false } })),
    }
  },
})

function StatsPage() {
  const { quickStats, fullStats } = Route.useLoaderData()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>({
    from: '',
    to: new Date().toISOString().split('T')[0],
  })
  const [filteredStats, setFilteredStats] = useState<SerializableStats | null>(null)
  const [isLoadingRange, setIsLoadingRange] = useState(false)

  const handleRefresh = () => {
    setIsRefreshing(true)
    // Force refresh by reloading with a query param
    const url = new URL(window.location.href)
    url.searchParams.set('refresh', Date.now().toString())
    window.location.href = url.toString()
  }

  const handleDateRangeChange = async (range: { from: string; to: string }) => {
    setDateRange(range)

    // Only fetch if we have both dates
    if (range.from && range.to) {
      setIsLoadingRange(true)
      try {
        const stats = await getStatsInRange({ data: range })
        setFilteredStats(stats)
      } catch (error) {
        console.error('Failed to fetch stats for date range:', error)
      } finally {
        setIsLoadingRange(false)
      }
    } else {
      setFilteredStats(null)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between mb-4">
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to conversations
            </Link>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">
            Statistics
          </h1>
          <p className="text-muted-foreground mt-1">
            Overview of your Claude Code usage
            {quickStats.isCached && (
              <span className="text-xs ml-2 text-cyan-400">(cached)</span>
            )}
          </p>
        </div>
      </header>

      {/* Date Range Filter */}
      <div className="max-w-7xl mx-auto px-6 pt-6">
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <Calendar className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium text-foreground">Filter by date:</span>
              <DateRangePicker value={dateRange} onChange={handleDateRangeChange} />
              {isLoadingRange && (
                <span className="text-xs text-cyan-400 animate-pulse">Loading...</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <main className="max-w-7xl mx-auto px-6 pb-8">
        {/* Stats Cards - Show filtered stats when date range is active */}
        {filteredStats ? (
          <FilteredStatCards stats={filteredStats} isFiltered={true} />
        ) : (
          <QuickStatCards stats={quickStats} />
        )}

        {/* Activity Chart - Deferred or filtered */}
        {filteredStats ? (
          <ActivityChart stats={filteredStats} />
        ) : (
          <Suspense fallback={<ActivityChartSkeleton />}>
            <Await promise={fullStats}>
              {(stats) => <ActivityChart stats={stats} />}
            </Await>
          </Suspense>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Projects - Deferred or filtered */}
          {filteredStats ? (
            <TopProjectsCard projectCounts={filteredStats.projectCounts} />
          ) : (
            <Suspense fallback={<ProjectListSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <TopProjectsCard projectCounts={stats.projectCounts} />}
              </Await>
            </Suspense>
          )}

          {/* Tool Usage - Deferred or filtered */}
          {filteredStats ? (
            <TopToolsCard toolCounts={filteredStats.toolCounts} />
          ) : (
            <Suspense fallback={<ToolBadgesSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <TopToolsCard toolCounts={stats.toolCounts} />}
              </Await>
            </Suspense>
          )}
        </div>

        {/* Weekly Trends & Token Usage Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Weekly Trends - Deferred or filtered */}
          {filteredStats ? (
            <WeeklyTrendsCard dailyActivity={filteredStats.dailyActivity} dailyTokens={filteredStats.dailyTokens} />
          ) : (
            <Suspense fallback={<WeeklyTrendsSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <WeeklyTrendsCard dailyActivity={stats.dailyActivity} dailyTokens={stats.dailyTokens} />}
              </Await>
            </Suspense>
          )}

          {/* Token Usage - Deferred or filtered */}
          {filteredStats ? (
            <TokenUsageCard tokenUsage={filteredStats.tokenUsage} />
          ) : (
            <Suspense fallback={<TokenUsageSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <TokenUsageCard tokenUsage={stats.tokenUsage} />}
              </Await>
            </Suspense>
          )}
        </div>

        {/* Cumulative Growth Chart */}
        {filteredStats ? (
          <div className="mb-8">
            <CumulativeChart dailyActivity={filteredStats.dailyActivity} dailyTokens={filteredStats.dailyTokens} />
          </div>
        ) : (
          <Suspense fallback={<ActivityChartSkeleton />}>
            <Await promise={fullStats}>
              {(stats) => (
                <div className="mb-8">
                  <CumulativeChart dailyActivity={stats.dailyActivity} dailyTokens={stats.dailyTokens} />
                </div>
              )}
            </Await>
          </Suspense>
        )}

        {/* Model Usage & Cache Efficiency Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Model Usage - Deferred or filtered */}
          {filteredStats ? (
            <ModelUsageChart modelCounts={filteredStats.modelCounts} />
          ) : (
            <Suspense fallback={<ModelUsageSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <ModelUsageChart modelCounts={stats.modelCounts} />}
              </Await>
            </Suspense>
          )}

          {/* Tool Categories - Deferred or filtered */}
          {filteredStats ? (
            <ToolCategoriesChart toolCounts={filteredStats.toolCounts} />
          ) : (
            <Suspense fallback={<ToolCategoriesSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <ToolCategoriesChart toolCounts={stats.toolCounts} />}
              </Await>
            </Suspense>
          )}
        </div>

        {/* Extended Analytics Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Hourly Heatmap - Deferred or filtered */}
          {filteredStats ? (
            <HourlyHeatmap hourlyActivity={filteredStats.hourlyActivity} />
          ) : (
            <Suspense fallback={<HourlyHeatmapSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <HourlyHeatmap hourlyActivity={stats.hourlyActivity} />}
              </Await>
            </Suspense>
          )}

          {/* Branch Activity - Deferred or filtered */}
          {filteredStats ? (
            <BranchActivityChart branchCounts={filteredStats.branchCounts} />
          ) : (
            <Suspense fallback={<BranchActivitySkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <BranchActivityChart branchCounts={stats.branchCounts} />}
              </Await>
            </Suspense>
          )}
        </div>

        {/* Bottom Row: Conversation Length */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Conversation Length Distribution - Deferred or filtered */}
          {filteredStats ? (
            <ConversationLengthHistogram conversationLengths={filteredStats.conversationLengths} />
          ) : (
            <Suspense fallback={<ConversationLengthSkeleton />}>
              <Await promise={fullStats}>
                {(stats) => <ConversationLengthHistogram conversationLengths={stats.conversationLengths} />}
              </Await>
            </Suspense>
          )}
        </div>
      </main>
    </div>
  )
}

// =============================================================================
// Quick Stat Cards (load immediately from cache)
// =============================================================================

function QuickStatCards({ stats }: { stats: QuickStatsResponse }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
      <StatCard
        icon={<MessageSquare className="w-5 h-5" />}
        label="Total Conversations"
        value={stats.totalConversations}
        color="primary"
      />
      <StatCard
        icon={<Activity className="w-5 h-5" />}
        label="Total Messages"
        value={stats.totalMessages}
        color="secondary"
      />
      <StatCard
        icon={<FolderOpen className="w-5 h-5" />}
        label="Projects"
        value={stats.projectCount}
        color="primary"
      />
      <StatCard
        icon={<Bot className="w-5 h-5" />}
        label="Subagent Sessions"
        value={stats.subagentCount}
        color="secondary"
      />
    </div>
  )
}

// =============================================================================
// Filtered Stat Cards (when date range is active)
// =============================================================================

function FilteredStatCards({ stats, isFiltered }: { stats: SerializableStats; isFiltered: boolean }) {
  const totalTokens = stats.tokenUsage.inputTokens + stats.tokenUsage.outputTokens +
    stats.tokenUsage.cacheCreateTokens + stats.tokenUsage.cacheReadTokens

  // Format tokens with K/M suffix
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return n.toString()
  }

  return (
    <div className="space-y-2 mb-8">
      {isFiltered && (
        <div className="flex items-center gap-2 text-xs text-cyan-400">
          <Filter className="w-3 h-3" />
          <span>Showing filtered results</span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          icon={<MessageSquare className="w-5 h-5" />}
          label="Conversations"
          value={stats.totalConversations}
          color="primary"
        />
        <StatCard
          icon={<Activity className="w-5 h-5" />}
          label="Messages"
          value={stats.totalMessages}
          color="secondary"
        />
        <StatCard
          icon={<Coins className="w-5 h-5" />}
          label="Total Tokens"
          value={totalTokens}
          color="primary"
          formatted={formatTokens(totalTokens)}
        />
        <StatCard
          icon={<Bot className="w-5 h-5" />}
          label="Subagent Sessions"
          value={stats.subagentCount}
          color="secondary"
        />
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  color,
  formatted,
}: {
  icon: React.ReactNode
  label: string
  value: number
  color: 'primary' | 'secondary'
  formatted?: string
}) {
  const isPrimary = color === 'primary'

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-lg ${isPrimary ? 'bg-primary/15' : 'bg-secondary/15'}`}>
            <div className={isPrimary ? 'text-primary' : 'text-secondary'}>{icon}</div>
          </div>
          <div>
            <p className="text-2xl font-bold text-foreground">
              {formatted || value.toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Activity Chart (deferred)
// =============================================================================

interface FullStats {
  totalConversations: number
  totalMessages: number
  projectCounts: Record<string, number>
  toolCounts: Record<string, number>
  dailyActivity: Record<string, number>
  subagentCount: number
}

function ActivityChart({ stats }: { stats: FullStats }) {
  const recentDays = Object.entries(stats.dailyActivity)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 14)
    .reverse()

  const maxDailyMessages = Math.max(...recentDays.map(([, count]) => count), 1)

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          Recent Activity (Last 14 Days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-1 h-32">
          {recentDays.map(([date, count]) => (
            <div key={date} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
              <div
                className="w-full bg-primary rounded-t opacity-80 hover:opacity-100 transition-opacity"
                style={{ height: `${(count / maxDailyMessages) * 100}%`, minHeight: count > 0 ? '4px' : '0' }}
                title={`${date}: ${count} messages`}
              />
              <span className="text-[8px] text-muted-foreground rotate-45 origin-left translate-y-2">
                {new Date(date).getUTCDate()}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Top Projects Card (deferred)
// =============================================================================

function TopProjectsCard({ projectCounts }: { projectCounts: Record<string, number> }) {
  const sortedProjects = Object.entries(projectCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="w-5 h-5 text-secondary" />
          Top Projects
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {sortedProjects.map(([project, count]) => (
            <div key={project} className="flex items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-foreground truncate">
                    {project}
                  </span>
                  <span className="text-xs text-muted-foreground">{count}</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-secondary rounded-full"
                    style={{
                      width: `${(count / (sortedProjects[0]?.[1] || 1)) * 100}%`,
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Top Tools Card (deferred)
// =============================================================================

function TopToolsCard({ toolCounts }: { toolCounts: Record<string, number> }) {
  const sortedTools = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="w-5 h-5 text-primary" />
          Top Tools Used
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {sortedTools.map(([tool, count]) => (
            <Badge key={tool}>
              {tool.replace(/^mcp__\w+__/, '')}
              <span className="ml-1.5 font-bold">{count}</span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Skeleton Components for Extended Analytics
// =============================================================================

function HourlyHeatmapSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-36" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-12 gap-1 mb-4">
          {Array.from({ length: 24 }).map((_, i) => (
            <Skeleton
              key={i}
              className="aspect-square rounded-sm"
              style={{ animationDelay: `${i * 50}ms` }}
            />
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Skeleton className="h-3 w-8" />
          <div className="flex gap-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="w-3 h-3 rounded-sm" />
            ))}
          </div>
          <Skeleton className="h-3 w-8" />
        </div>
      </CardContent>
    </Card>
  )
}

function ToolCategoriesSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-32" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-full rounded-lg mb-4" variant="data-stream" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="w-3 h-3 rounded-sm" />
              <Skeleton className="h-3 flex-1" style={{ animationDelay: `${i * 100}ms` }} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function WeeklyTrendsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-28" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function TokenUsageSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-24" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-3 mb-4">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-6 w-16 ml-auto" />
        </div>
        <Skeleton className="h-3 w-full rounded-full mb-4" />
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" style={{ animationDelay: `${i * 75}ms` }} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function ModelUsageSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-24" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <Skeleton className="w-28 h-28 rounded-full" />
          <div className="flex-1 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" style={{ animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function BranchActivitySkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-32" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="flex justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-10" />
              </div>
              <Skeleton className="h-1.5 w-full rounded-full" style={{ animationDelay: `${i * 50}ms` }} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function ConversationLengthSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="h-5 w-48" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4 mb-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex items-end gap-2 h-24 mb-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              className="flex-1 rounded-t"
              style={{ height: `${20 + Math.random() * 60}%`, animationDelay: `${i * 75}ms` }}
            />
          ))}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="flex-1 h-3" />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
