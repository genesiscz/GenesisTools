import { createFileRoute, Link } from '@tanstack/react-router'
import { getStats, getProjects } from '@/server/conversations'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, MessageSquare, FolderOpen, Wrench, Activity, Bot, TrendingUp } from 'lucide-react'

export const Route = createFileRoute('/stats')({
  component: StatsPage,
  loader: async () => {
    const [stats, projects] = await Promise.all([getStats(), getProjects()])
    return { stats, projects }
  },
})

function StatsPage() {
  const { stats, projects } = Route.useLoaderData()

  // Sort projects by conversation count
  const sortedProjects = Object.entries(stats.projectCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  // Sort tools by usage count
  const sortedTools = Object.entries(stats.toolCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)

  // Get recent activity (last 14 days)
  const recentDays = Object.entries(stats.dailyActivity)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 14)
    .reverse()

  const maxDailyMessages = Math.max(...recentDays.map(([, count]) => count), 1)

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="border-b border-[var(--border-primary)]">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to conversations
          </Link>
          <h1 className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
            Statistics
          </h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Overview of your Claude Code usage
          </p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
            value={projects.length}
            color="primary"
          />
          <StatCard
            icon={<Bot className="w-5 h-5" />}
            label="Subagent Sessions"
            value={stats.subagentCount}
            color="secondary"
          />
        </div>

        {/* Activity Chart */}
        <Card className="bg-[var(--bg-secondary)] border-[var(--border-primary)] mb-8">
          <CardHeader>
            <CardTitle className="text-[var(--text-primary)] flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-[var(--neon-primary)]" />
              Recent Activity (Last 14 Days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-32">
              {recentDays.map(([date, count]) => (
                <div key={date} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className="w-full bg-[var(--neon-primary)] rounded-t opacity-80 hover:opacity-100 transition-opacity"
                    style={{ height: `${(count / maxDailyMessages) * 100}%`, minHeight: count > 0 ? '4px' : '0' }}
                    title={`${date}: ${count} messages`}
                  />
                  <span className="text-[8px] text-[var(--text-muted)] rotate-45 origin-left translate-y-2">
                    {new Date(date).getDate()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Projects */}
          <Card className="bg-[var(--bg-secondary)] border-[var(--border-primary)]">
            <CardHeader>
              <CardTitle className="text-[var(--text-primary)] flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-[var(--neon-secondary)]" />
                Top Projects
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sortedProjects.map(([project, count]) => (
                  <div key={project} className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-[var(--text-primary)] truncate">
                          {project}
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">{count}</span>
                      </div>
                      <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--neon-secondary)] rounded-full"
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

          {/* Tool Usage */}
          <Card className="bg-[var(--bg-secondary)] border-[var(--border-primary)]">
            <CardHeader>
              <CardTitle className="text-[var(--text-primary)] flex items-center gap-2">
                <Wrench className="w-5 h-5 text-[var(--neon-primary)]" />
                Top Tools Used
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {sortedTools.map(([tool, count]) => (
                  <Badge
                    key={tool}
                    variant="outline"
                    className="border-[var(--border-secondary)] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]"
                  >
                    {tool.replace(/^mcp__\w+__/, '')}
                    <span className="ml-1.5 text-[var(--neon-primary)]">{count}</span>
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode
  label: string
  value: number
  color: 'primary' | 'secondary'
}) {
  const colorClass = color === 'primary' ? 'var(--neon-primary)' : 'var(--neon-secondary)'

  return (
    <Card className="bg-[var(--bg-secondary)] border-[var(--border-primary)]">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div
            className="p-2 rounded-lg"
            style={{ backgroundColor: `color-mix(in oklch, ${colorClass} 15%, transparent)` }}
          >
            <div style={{ color: colorClass }}>{icon}</div>
          </div>
          <div>
            <p className="text-2xl font-bold text-[var(--text-primary)]">
              {value.toLocaleString()}
            </p>
            <p className="text-xs text-[var(--text-muted)]">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
