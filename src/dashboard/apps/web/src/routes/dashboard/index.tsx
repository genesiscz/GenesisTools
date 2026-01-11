import { createFileRoute, Link } from '@tanstack/react-router'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
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
import { FeatureCard, FeatureCardHeader, FeatureCardContent, type FeatureCardColor } from '@/components/ui/feature-card'
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
    color: 'cyan' as FeatureCardColor,
    badge: 'Active',
  },
  {
    title: 'AI Assistant',
    description: 'Your personal AI companion for tasks, research, and creativity',
    icon: Brain,
    href: '/dashboard/ai',
    color: 'purple' as FeatureCardColor,
    badge: 'Coming Soon',
  },
  {
    title: 'Focus Mode',
    description: 'Deep work sessions with Pomodoro technique and distraction blocking',
    icon: Target,
    href: '/dashboard/focus',
    color: 'amber' as FeatureCardColor,
    badge: 'Coming Soon',
  },
  {
    title: 'Quick Notes',
    description: 'Capture thoughts instantly with markdown support and tagging',
    icon: StickyNote,
    href: '/dashboard/notes',
    color: 'emerald' as FeatureCardColor,
    badge: 'Coming Soon',
  },
  {
    title: 'Bookmarks',
    description: 'Save and organize links with AI-powered summaries and search',
    icon: Bookmark,
    href: '/dashboard/bookmarks',
    color: 'rose' as FeatureCardColor,
    badge: 'Coming Soon',
  },
  {
    title: 'Daily Planner',
    description: 'AI-assisted daily planning with smart scheduling and reminders',
    icon: CalendarDays,
    href: '/dashboard/planner',
    color: 'blue' as FeatureCardColor,
    badge: 'Coming Soon',
  },
]

const colorStyles = {
  cyan: { bg: 'bg-cyan-500/10', icon: 'text-cyan-400', badge: 'bg-cyan-500/20 text-cyan-400' },
  purple: { bg: 'bg-purple-500/10', icon: 'text-purple-400', badge: 'bg-purple-500/20 text-purple-400' },
  amber: { bg: 'bg-amber-500/10', icon: 'text-amber-400', badge: 'bg-amber-500/20 text-amber-400' },
  emerald: { bg: 'bg-emerald-500/10', icon: 'text-emerald-400', badge: 'bg-emerald-500/20 text-emerald-400' },
  rose: { bg: 'bg-rose-500/10', icon: 'text-rose-400', badge: 'bg-rose-500/20 text-rose-400' },
  blue: { bg: 'bg-blue-500/10', icon: 'text-blue-400', badge: 'bg-blue-500/20 text-blue-400' },
  primary: { bg: 'bg-primary/10', icon: 'text-primary', badge: 'bg-primary/20 text-primary' },
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
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/8 via-transparent to-accent/8 p-8 backdrop-blur-sm">
          <div className="absolute top-0 right-0 w-96 h-96 bg-primary/15 rounded-full blur-3xl -translate-y-1/3 translate-x-1/3 opacity-50" />
          <div className="absolute bottom-0 left-0 w-72 h-72 bg-accent/12 rounded-full blur-3xl translate-y-1/3 -translate-x-1/3 opacity-50" />

          <div className="relative z-10">
            <div className="flex items-center gap-2 text-primary/70 text-xs tracking-widest uppercase mb-2 font-semibold">
              <Sparkles className="h-3 w-3 animate-pulse-subtle" />
              <span>Welcome Back</span>
            </div>
            <h2 className="text-4xl font-bold mb-3">
              {greeting()}, <span className="gradient-text">{user?.firstName || 'Commander'}</span>
            </h2>
            <p className="text-foreground/70 max-w-xl leading-relaxed">
              Your NEXUS command center is online. All systems operational and ready to optimize your productivity.
            </p>

            {/* Quick Stats */}
            <div className="flex gap-6 mt-8">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-accent/10 border border-accent/30 backdrop-blur-sm">
                <div className="p-2 rounded-lg bg-accent/20">
                  <Clock className="h-4 w-4 text-accent" />
                </div>
                <div>
                  <div className="text-2xl font-mono font-bold text-accent">0:00:00</div>
                  <div className="text-[10px] text-foreground/60 uppercase tracking-wider font-medium">Time Today</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/30 backdrop-blur-sm">
                <div className="p-2 rounded-lg bg-primary/20">
                  <TrendingUp className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-2xl font-mono font-bold text-primary">0</div>
                  <div className="text-[10px] text-foreground/60 uppercase tracking-wider font-medium">Tasks Done</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Features Grid */}
        <div>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-2xl font-bold">Tools & Features</h3>
              <p className="text-foreground/50 text-sm mt-1">Your productivity toolkit</p>
            </div>
            <span className="text-xs font-semibold text-primary px-3 py-2 rounded-full bg-primary/10 border border-primary/30">
              {features.filter(f => f.badge === 'Active').length}/{features.length} Active
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((feature, index) => {
              const styles = colorStyles[feature.color]
              const isActive = feature.badge === 'Active'

              return (
                <Link key={feature.title} to={feature.href}>
                  <FeatureCard
                    color={feature.color}
                    className="h-full animate-slide-up"
                    style={{ animationDelay: `${index * 50}ms` } as React.CSSProperties}
                  >
                    <FeatureCardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div className={`p-2.5 rounded-lg ${styles.bg}`}>
                          <feature.icon className={`h-5 w-5 ${styles.icon}`} />
                        </div>
                        <Badge variant="outline" className={`text-[10px] ${styles.badge} border-0`}>
                          {feature.badge}
                        </Badge>
                      </div>
                      <h4 className="text-base font-semibold mt-3">{feature.title}</h4>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {feature.description}
                      </p>
                    </FeatureCardHeader>
                    <FeatureCardContent className="pt-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`p-0 h-auto text-xs ${styles.icon} opacity-0 group-hover:opacity-100 transition-opacity`}
                        disabled={!isActive}
                      >
                        {isActive ? 'Open' : 'Coming Soon'}
                        {isActive && <ArrowRight className="ml-1 h-3 w-3" />}
                      </Button>
                    </FeatureCardContent>
                  </FeatureCard>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
