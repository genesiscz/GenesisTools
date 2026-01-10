import { createFileRoute, Link } from '@tanstack/react-router'
import { useAuth } from '@workos-inc/authkit-react'
import {
  Timer,
  Brain,
  Target,
  StickyNote,
  Bookmark,
  CalendarDays,
  ArrowRight,
  Sparkles,
  Clock,
  TrendingUp,
} from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/dashboard/')({
  component: DashboardPage,
})

const features = [
  {
    title: 'Timer',
    description: 'Precision time tracking with stopwatch and countdown modes',
    icon: Timer,
    href: '/timer',
    color: 'cyan',
    badge: 'Active',
  },
  {
    title: 'AI Assistant',
    description: 'Your personal AI companion for tasks, research, and creativity',
    icon: Brain,
    href: '/dashboard/ai',
    color: 'purple',
    badge: 'Coming Soon',
  },
  {
    title: 'Focus Mode',
    description: 'Deep work sessions with Pomodoro technique and distraction blocking',
    icon: Target,
    href: '/dashboard/focus',
    color: 'amber',
    badge: 'Coming Soon',
  },
  {
    title: 'Quick Notes',
    description: 'Capture thoughts instantly with markdown support and tagging',
    icon: StickyNote,
    href: '/dashboard/notes',
    color: 'emerald',
    badge: 'Coming Soon',
  },
  {
    title: 'Bookmarks',
    description: 'Save and organize links with AI-powered summaries and search',
    icon: Bookmark,
    href: '/dashboard/bookmarks',
    color: 'rose',
    badge: 'Coming Soon',
  },
  {
    title: 'Daily Planner',
    description: 'AI-assisted daily planning with smart scheduling and reminders',
    icon: CalendarDays,
    href: '/dashboard/planner',
    color: 'blue',
    badge: 'Coming Soon',
  },
]

const colorClasses = {
  cyan: {
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/20 hover:border-cyan-500/40',
    icon: 'text-cyan-400',
    glow: 'hover:shadow-cyan-500/10',
    badge: 'bg-cyan-500/20 text-cyan-400',
  },
  purple: {
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20 hover:border-purple-500/40',
    icon: 'text-purple-400',
    glow: 'hover:shadow-purple-500/10',
    badge: 'bg-purple-500/20 text-purple-400',
  },
  amber: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20 hover:border-amber-500/40',
    icon: 'text-amber-400',
    glow: 'hover:shadow-amber-500/10',
    badge: 'bg-amber-500/20 text-amber-400',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20 hover:border-emerald-500/40',
    icon: 'text-emerald-400',
    glow: 'hover:shadow-emerald-500/10',
    badge: 'bg-emerald-500/20 text-emerald-400',
  },
  rose: {
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/20 hover:border-rose-500/40',
    icon: 'text-rose-400',
    glow: 'hover:shadow-rose-500/10',
    badge: 'bg-rose-500/20 text-rose-400',
  },
  blue: {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20 hover:border-blue-500/40',
    icon: 'text-blue-400',
    glow: 'hover:shadow-blue-500/10',
    badge: 'bg-blue-500/20 text-blue-400',
  },
}

function DashboardPage() {
  const { user } = useAuth()

  const greeting = () => {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
  }

  return (
    <DashboardLayout title="Dashboard" description="Your personal command center">
      <div className="space-y-8">
        {/* Welcome Section */}
        <div className="relative overflow-hidden rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/5 via-transparent to-cyan-500/5 p-8">
          <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />

          <div className="relative">
            <div className="flex items-center gap-2 text-amber-500/60 text-xs tracking-widest uppercase mb-2">
              <Sparkles className="h-3 w-3" />
              <span>Welcome Back</span>
            </div>
            <h2 className="text-3xl font-bold mb-2">
              {greeting()}, <span className="gradient-text">{user?.firstName || 'Commander'}</span>
            </h2>
            <p className="text-muted-foreground max-w-xl">
              Your NEXUS command center is online. All systems operational. Ready to optimize your productivity.
            </p>

            {/* Quick Stats */}
            <div className="flex gap-6 mt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10">
                  <Clock className="h-4 w-4 text-cyan-400" />
                </div>
                <div>
                  <div className="text-2xl font-mono font-bold text-cyan-400">0:00:00</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Time Today</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-500/10">
                  <TrendingUp className="h-4 w-4 text-amber-400" />
                </div>
                <div>
                  <div className="text-2xl font-mono font-bold text-amber-400">0</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Tasks Done</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Features Grid */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Tools & Features</h3>
            <span className="text-xs text-muted-foreground">
              {features.filter(f => f.badge === 'Active').length} active / {features.length} total
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((feature) => {
              const colors = colorClasses[feature.color as keyof typeof colorClasses]
              const isActive = feature.badge === 'Active'

              return (
                <Link key={feature.title} to={feature.href}>
                  <Card className={`group relative overflow-hidden transition-all duration-300 ${colors.border} ${colors.glow} hover:shadow-lg bg-[#0a0a14]/80 backdrop-blur-sm h-full`}>
                    {/* Tech corner decorations */}
                    <div className="absolute top-0 left-0 w-4 h-4 border-l-2 border-t-2 border-amber-500/30 rounded-tl" />
                    <div className="absolute bottom-0 right-0 w-4 h-4 border-r-2 border-b-2 border-amber-500/30 rounded-br" />

                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className={`p-2.5 rounded-lg ${colors.bg}`}>
                          <feature.icon className={`h-5 w-5 ${colors.icon}`} />
                        </div>
                        <Badge variant="outline" className={`text-[10px] ${colors.badge} border-0`}>
                          {feature.badge}
                        </Badge>
                      </div>
                      <CardTitle className="text-base mt-3">{feature.title}</CardTitle>
                      <CardDescription className="text-xs leading-relaxed">
                        {feature.description}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`p-0 h-auto text-xs ${colors.icon} opacity-0 group-hover:opacity-100 transition-opacity`}
                        disabled={!isActive}
                      >
                        {isActive ? 'Open' : 'Coming Soon'}
                        {isActive && <ArrowRight className="ml-1 h-3 w-3" />}
                      </Button>
                    </CardContent>
                  </Card>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
