import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardTitle,
  FeatureCardDescription,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import type { TaskBlocker, Task } from '@/lib/assistant/types'
import { BlockerCard } from './BlockerCard'
import { BlockerActions } from './BlockerActions'

interface BlockerListProps {
  blockers: TaskBlocker[]
  tasks: Task[]
  onRemind?: (blocker: TaskBlocker) => void
  onSwitch?: () => void
  onSetReminder?: (blocker: TaskBlocker, date: Date) => void
  onResolve?: (blockerId: string) => void
  maxItems?: number
  showHeader?: boolean
  variant?: 'full' | 'compact' | 'widget'
  className?: string
}

/**
 * Get urgency level based on time blocked
 */
function getBlockerUrgency(blockedSince: Date): 'normal' | 'warning' | 'critical' {
  const now = new Date()
  const diff = now.getTime() - new Date(blockedSince).getTime()
  const days = diff / (1000 * 60 * 60 * 24)

  if (days > 2) return 'critical'
  if (days > 1) return 'warning'
  return 'normal'
}

/**
 * Format time blocked in compact form
 */
function formatTimeBlockedCompact(blockedSince: Date): string {
  const now = new Date()
  const diff = now.getTime() - new Date(blockedSince).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (days === 0) {
    if (hours === 0) return 'now'
    return `${hours}h`
  }
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

/**
 * BlockerList - Dashboard widget showing all blockers
 *
 * Three variants:
 * - full: Full cards with all actions
 * - compact: Condensed list for sidebar
 * - widget: Dashboard widget with summary
 */
export function BlockerList({
  blockers,
  tasks,
  onRemind,
  onSwitch,
  onSetReminder,
  onResolve,
  maxItems,
  showHeader = true,
  variant = 'full',
  className,
}: BlockerListProps) {
  // Get task for each blocker
  function getTask(taskId: string): Task | undefined {
    return tasks.find((t) => t.id === taskId)
  }

  // Sort blockers: critical first, then by time blocked
  const sortedBlockers = [...blockers].sort((a, b) => {
    const urgencyA = getBlockerUrgency(new Date(a.blockedSince))
    const urgencyB = getBlockerUrgency(new Date(b.blockedSince))
    const urgencyOrder = { critical: 0, warning: 1, normal: 2 }

    const urgencyDiff = urgencyOrder[urgencyA] - urgencyOrder[urgencyB]
    if (urgencyDiff !== 0) return urgencyDiff

    // Older blockers first
    return new Date(a.blockedSince).getTime() - new Date(b.blockedSince).getTime()
  })

  const displayBlockers = maxItems ? sortedBlockers.slice(0, maxItems) : sortedBlockers
  const hasMore = maxItems && sortedBlockers.length > maxItems

  // Count critical blockers
  const criticalCount = blockers.filter(
    (b) => getBlockerUrgency(new Date(b.blockedSince)) === 'critical'
  ).length

  // Empty state
  if (blockers.length === 0) {
    return (
      <FeatureCard color="rose" className={className}>
        <FeatureCardHeader className="text-center py-8">
          <div className="flex justify-center mb-4">
            <div className="p-3 rounded-full bg-green-500/10 border border-green-500/20">
              <AlertTriangle className="h-6 w-6 text-green-400" />
            </div>
          </div>
          <FeatureCardTitle className="text-lg">No Blockers</FeatureCardTitle>
          <FeatureCardDescription>
            All tasks are unblocked. Keep up the momentum!
          </FeatureCardDescription>
        </FeatureCardHeader>
      </FeatureCard>
    )
  }

  // Widget variant
  if (variant === 'widget') {
    return (
      <FeatureCard color="rose" className={className}>
        <FeatureCardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'p-2 rounded-lg',
                  criticalCount > 0
                    ? 'bg-red-500/20 border border-red-500/30'
                    : 'bg-rose-500/10 border border-rose-500/20'
                )}
              >
                <AlertTriangle
                  className={cn(
                    'h-5 w-5',
                    criticalCount > 0 ? 'text-red-400' : 'text-rose-400'
                  )}
                />
              </div>
              <div>
                <FeatureCardTitle className="text-base">
                  Blockers ({blockers.length})
                </FeatureCardTitle>
                {criticalCount > 0 && (
                  <p className="text-xs text-red-400 font-medium">
                    {criticalCount} critical
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="text-rose-400 hover:text-rose-300"
            >
              <Link to="/assistant/tasks">View all</Link>
            </Button>
          </div>
        </FeatureCardHeader>

        <FeatureCardContent className="pt-0">
          <div className="space-y-2">
            {displayBlockers.map((blocker) => {
              const task = getTask(blocker.taskId)
              const urgency = getBlockerUrgency(new Date(blocker.blockedSince))

              return (
                <div
                  key={blocker.id}
                  className={cn(
                    'p-3 rounded-lg border transition-all',
                    'bg-rose-500/5 border-rose-500/20',
                    'hover:bg-rose-500/10 hover:border-rose-500/30',
                    urgency === 'critical' && 'border-red-500/30 bg-red-500/10'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      {task ? (
                        <Link
                          to="/assistant/tasks/$taskId"
                          params={{ taskId: task.id }}
                          className="text-sm font-medium hover:text-rose-400 transition-colors line-clamp-1"
                        >
                          {task.title}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-muted-foreground line-clamp-1">
                          Unknown Task
                        </span>
                      )}
                      <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                        {blocker.reason}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span
                        className={cn(
                          'text-[10px] font-medium',
                          urgency === 'critical' && 'text-red-400',
                          urgency === 'warning' && 'text-rose-400',
                          urgency === 'normal' && 'text-rose-300'
                        )}
                      >
                        {formatTimeBlockedCompact(new Date(blocker.blockedSince))}
                      </span>
                      <BlockerActions
                        blocker={blocker}
                        onRemind={onRemind}
                        onSwitch={onSwitch}
                        onSetReminder={onSetReminder}
                        onResolve={onResolve}
                        compact
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {hasMore && (
            <div className="mt-3 text-center">
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="text-rose-400 hover:text-rose-300"
              >
                <Link to="/assistant/tasks">
                  View {sortedBlockers.length - (maxItems || 0)} more
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            </div>
          )}
        </FeatureCardContent>
      </FeatureCard>
    )
  }

  // Compact variant
  if (variant === 'compact') {
    return (
      <div className={cn('space-y-2', className)}>
        {showHeader && (
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              Blockers ({blockers.length})
            </h3>
          </div>
        )}

        {displayBlockers.map((blocker) => {
          const task = getTask(blocker.taskId)
          const urgency = getBlockerUrgency(new Date(blocker.blockedSince))

          return (
            <div
              key={blocker.id}
              className={cn(
                'p-2.5 rounded-lg border',
                'bg-rose-500/5 border-rose-500/20',
                urgency === 'critical' && 'border-red-500/30'
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <div
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    urgency === 'critical' && 'bg-red-500 animate-pulse',
                    urgency === 'warning' && 'bg-rose-500',
                    urgency === 'normal' && 'bg-rose-400'
                  )}
                />
                {task ? (
                  <Link
                    to="/assistant/tasks/$taskId"
                    params={{ taskId: task.id }}
                    className="text-xs font-medium hover:text-rose-400 transition-colors line-clamp-1 flex-1"
                  >
                    {task.title}
                  </Link>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground line-clamp-1 flex-1">
                    Unknown
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {formatTimeBlockedCompact(new Date(blocker.blockedSince))}
                </span>
              </div>
              {blocker.blockerOwner && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <User className="h-3 w-3" />
                  {blocker.blockerOwner}
                </div>
              )}
            </div>
          )
        })}

        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="w-full text-rose-400 hover:text-rose-300"
          >
            <Link to="/assistant/tasks">
              +{sortedBlockers.length - (maxItems || 0)} more
            </Link>
          </Button>
        )}
      </div>
    )
  }

  // Full variant (default)
  return (
    <div className={className}>
      {showHeader && (
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-rose-400" />
            Blockers ({blockers.length})
            {criticalCount > 0 && (
              <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">
                {criticalCount} critical
              </span>
            )}
          </h2>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {displayBlockers.map((blocker, index) => {
          const task = getTask(blocker.taskId)

          return (
            <div
              key={blocker.id}
              className="animate-fade-in-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <BlockerCard
                blocker={blocker}
                task={task}
                onRemind={onRemind}
                onSwitch={onSwitch}
                onSetReminder={onSetReminder}
                onResolve={onResolve}
              />
            </div>
          )
        })}
      </div>

      {hasMore && (
        <div className="mt-4 text-center">
          <Button variant="outline" asChild className="text-rose-400 hover:text-rose-300">
            <Link to="/assistant/tasks">
              View all {sortedBlockers.length} blockers
              <ArrowRight className="h-4 w-4 ml-2" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  )
}
