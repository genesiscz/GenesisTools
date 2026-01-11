import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import {
  Compass,
  Loader2,
  AlertTriangle,
  AlertCircle,
  Sparkles,
  Calendar,
  Clock,
  Flame,
  Play,
  ParkingCircle,
  ChevronRight,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { DashboardLayout } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import { useTaskStore } from './hooks'
import type { Task, ContextParking, UrgencyLevel } from './types'
import { getUrgencyColor } from './types'

export const Route = createFileRoute('/assistant/next')({
  component: WhatsNextPage,
})

interface Recommendation {
  task: Task
  score: number
  reasons: string[]
  parkingContext?: ContextParking | null
}

function WhatsNextPage() {
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null

  const { tasks, streak, loading, initialized, updateTask, getActiveParking } =
    useTaskStore(userId)

  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [alternatives, setAlternatives] = useState<Recommendation[]>([])
  const [loadingRecommendation, setLoadingRecommendation] = useState(false)

  // Get active (non-completed) tasks
  const activeTasks = tasks.filter((t) => t.status !== 'completed')

  // Calculate recommendations when tasks change
  useEffect(() => {
    async function calculateRecommendations() {
      if (activeTasks.length === 0) {
        setRecommendation(null)
        setAlternatives([])
        return
      }

      setLoadingRecommendation(true)

      try {
        const scored: Recommendation[] = []

        for (const task of activeTasks) {
          const { score, reasons } = calculatePriorityScore(task)
          const parkingContext = await getActiveParking(task.id)

          scored.push({
            task,
            score,
            reasons,
            parkingContext,
          })
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score)

        // Top recommendation
        setRecommendation(scored[0] || null)

        // Next 3 alternatives
        setAlternatives(scored.slice(1, 4))
      } finally {
        setLoadingRecommendation(false)
      }
    }

    if (initialized) {
      calculateRecommendations()
    }
  }, [activeTasks, initialized, getActiveParking])

  /**
   * Calculate priority score for a task
   * Higher score = higher priority
   */
  function calculatePriorityScore(task: Task): { score: number; reasons: string[] } {
    let score = 0
    const reasons: string[] = []

    // 1. Urgency weight (critical > important > nice-to-have)
    switch (task.urgencyLevel) {
      case 'critical':
        score += 100
        reasons.push('Critical priority')
        break
      case 'important':
        score += 50
        reasons.push('Important priority')
        break
      case 'nice-to-have':
        score += 10
        break
    }

    // 2. Shipping blocker bonus
    if (task.isShippingBlocker) {
      score += 50
      reasons.push('Blocks shipping')
    }

    // 3. Deadline proximity
    if (task.deadline) {
      const now = new Date()
      const deadline = new Date(task.deadline)
      const daysUntil = Math.floor(
        (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )

      if (daysUntil < 0) {
        score += 80 // Overdue
        reasons.push('Overdue!')
      } else if (daysUntil === 0) {
        score += 60 // Due today
        reasons.push('Due today')
      } else if (daysUntil === 1) {
        score += 40 // Due tomorrow
        reasons.push('Due tomorrow')
      } else if (daysUntil <= 3) {
        score += 25 // Due within 3 days
        reasons.push(`Due in ${daysUntil} days`)
      } else if (daysUntil <= 7) {
        score += 10 // Due within a week
      }
    }

    // 4. In-progress bonus (reduce context switching)
    if (task.status === 'in-progress') {
      score += 30
      reasons.push('Already started')
    }

    // 5. Has context parked (easier to resume)
    if (task.contextParkingLot) {
      score += 15
      reasons.push('Has context saved')
    }

    // 6. Time already invested
    if (task.focusTimeLogged > 60) {
      score += 10
      reasons.push('Time invested')
    }

    return { score, reasons }
  }

  // Handle start work
  async function handleStartWork(taskId: string) {
    await updateTask(taskId, { status: 'in-progress' })
  }

  // Refresh recommendations
  function handleRefresh() {
    // Trigger recalculation
    setLoadingRecommendation(true)
    setTimeout(() => setLoadingRecommendation(false), 300)
  }

  // Loading state
  if (authLoading || (!initialized && loading)) {
    return (
      <DashboardLayout title="What's Next" description="Your priority recommendation">
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
            <span className="text-muted-foreground text-sm font-mono">
              Calculating priorities...
            </span>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout
      title="What's Next"
      description="Smart task prioritization based on urgency, deadline, and context"
    >
      {/* Header with streak and refresh */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          {streak && streak.currentStreakDays > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-orange-400">
              <Flame className="h-4 w-4" />
              <span className="font-semibold">{streak.currentStreakDays} day streak</span>
            </div>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loadingRecommendation}
          className="gap-2"
        >
          <RefreshCw
            className={cn('h-4 w-4', loadingRecommendation && 'animate-spin')}
          />
          Refresh
        </Button>
      </div>

      {/* No tasks state */}
      {activeTasks.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Main recommendation - 2 columns */}
          <div className="lg:col-span-2">
            {recommendation && (
              <RecommendationCard
                recommendation={recommendation}
                onStartWork={() => handleStartWork(recommendation.task.id)}
                isPrimary
              />
            )}
          </div>

          {/* Alternatives - 1 column */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Also Consider
            </h3>

            {alternatives.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No other tasks available.
              </p>
            ) : (
              alternatives.map((alt) => (
                <RecommendationCard
                  key={alt.task.id}
                  recommendation={alt}
                  onStartWork={() => handleStartWork(alt.task.id)}
                />
              ))
            )}

            {/* View all tasks link */}
            <Button asChild variant="ghost" className="w-full justify-between">
              <Link to="/assistant/tasks">
                View all tasks
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}

/**
 * Recommendation card component
 */
function RecommendationCard({
  recommendation,
  onStartWork,
  isPrimary = false,
}: {
  recommendation: Recommendation
  onStartWork: () => void
  isPrimary?: boolean
}) {
  const { task, reasons, parkingContext } = recommendation
  const urgencyColors = getUrgencyColor(task.urgencyLevel)

  const urgencyConfig = {
    critical: { icon: AlertTriangle, label: 'Critical', color: 'text-red-400' },
    important: { icon: AlertCircle, label: 'Important', color: 'text-orange-400' },
    'nice-to-have': { icon: Sparkles, label: 'Nice to Have', color: 'text-yellow-400' },
  }

  const urgency = urgencyConfig[task.urgencyLevel]
  const UrgencyIcon = urgency.icon

  return (
    <FeatureCard
      color={
        task.urgencyLevel === 'critical'
          ? 'rose'
          : task.urgencyLevel === 'important'
            ? 'amber'
            : 'purple'
      }
      className={cn(isPrimary && 'border-2')}
    >
      <FeatureCardHeader>
        {/* Header with urgency badge */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <UrgencyIcon className={cn('h-4 w-4', urgency.color)} />
            <span className={cn('text-xs font-semibold uppercase', urgency.color)}>
              {urgency.label}
            </span>
          </div>

          {isPrimary && (
            <span className="text-[10px] uppercase tracking-wider font-bold text-purple-400 px-2 py-1 rounded bg-purple-500/20">
              Recommended
            </span>
          )}
        </div>

        {/* Task title */}
        <Link
          to="/assistant/tasks/$taskId"
          params={{ taskId: task.id }}
          className="group/link"
        >
          <h3
            className={cn(
              'font-semibold leading-snug transition-colors',
              'group-hover/link:text-purple-400',
              isPrimary ? 'text-xl' : 'text-base'
            )}
          >
            {task.title}
          </h3>
        </Link>

        {/* Description */}
        {isPrimary && task.description && (
          <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
            {task.description}
          </p>
        )}

        {/* Priority reasons */}
        <div className="flex flex-wrap gap-2 mt-3">
          {reasons.slice(0, isPrimary ? 4 : 2).map((reason, i) => (
            <span
              key={i}
              className="text-[10px] px-2 py-0.5 rounded bg-muted/50 text-muted-foreground"
            >
              {reason}
            </span>
          ))}
        </div>

        {/* Metadata row */}
        <div className="flex items-center gap-4 mt-4 text-xs text-muted-foreground">
          {task.deadline && (
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              <span>{formatDeadline(new Date(task.deadline))}</span>
            </div>
          )}
          {task.focusTimeLogged > 0 && (
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              <span>{formatFocusTime(task.focusTimeLogged)}</span>
            </div>
          )}
        </div>

        {/* Context parking preview */}
        {isPrimary && parkingContext && (
          <div className="mt-4 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
            <div className="flex items-center gap-2 mb-1.5">
              <ParkingCircle className="h-3.5 w-3.5 text-purple-400" />
              <span className="text-xs font-medium text-purple-300">Where you left off:</span>
            </div>
            <p className="text-sm text-foreground/80 line-clamp-2">
              {parkingContext.content}
            </p>
          </div>
        )}
      </FeatureCardHeader>

      <FeatureCardContent className={cn(!isPrimary && 'pt-0')}>
        <Button
          onClick={onStartWork}
          className={cn(
            'w-full gap-2',
            isPrimary
              ? 'bg-purple-600 hover:bg-purple-700'
              : 'bg-transparent border border-purple-500/30 text-purple-400 hover:bg-purple-500/10'
          )}
          size={isPrimary ? 'default' : 'sm'}
        >
          <Play className="h-4 w-4" />
          {task.status === 'in-progress' ? 'Continue' : 'Start Working'}
        </Button>
      </FeatureCardContent>
    </FeatureCard>
  )
}

/**
 * Empty state when no tasks
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6">
      <div
        className={cn(
          'relative w-32 h-32 mb-8',
          'flex items-center justify-center',
          'rounded-full',
          'bg-gradient-to-br from-purple-500/10 to-purple-500/5',
          'border border-purple-500/20'
        )}
      >
        <Compass className="h-12 w-12 text-purple-400/50" />
      </div>

      <h2 className="text-xl font-semibold text-foreground/70 mb-2">All caught up!</h2>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        You have no active tasks. Great job! Add some tasks to get recommendations.
      </p>

      <Button asChild className="gap-2 bg-purple-600 hover:bg-purple-700">
        <Link to="/assistant/tasks">
          Go to Tasks
          <ChevronRight className="h-4 w-4" />
        </Link>
      </Button>
    </div>
  )
}

// Helper functions

function formatDeadline(deadline: Date): string {
  const now = new Date()
  const diff = deadline.getTime() - now.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (diff < 0) return 'Overdue'
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `${days} days left`
}

function formatFocusTime(minutes: number): string {
  if (minutes === 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60

  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}
