/**
 * BottleneckAlert - Warning component for bottleneck tasks
 *
 * Displays a prominent alert when a task is a bottleneck,
 * showing how many other tasks it blocks.
 */

import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight, ChevronRight, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { Task } from '@/lib/assistant/types'

interface BottleneckAlertProps {
  task: Task
  blockedTasks: Task[]
  className?: string
  onViewGraph?: () => void
}

/**
 * BottleneckAlert - Shows when viewing a task that blocks other tasks
 */
export function BottleneckAlert({
  task,
  blockedTasks,
  className,
  onViewGraph,
}: BottleneckAlertProps) {
  if (blockedTasks.length === 0) {
    return null
  }

  const isUrgent = task.urgencyLevel === 'critical'
  const blockedCount = blockedTasks.length

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border p-4',
        isUrgent
          ? 'bg-red-500/10 border-red-500/30'
          : 'bg-orange-500/10 border-orange-500/30',
        className
      )}
    >
      {/* Pulsing background for urgency */}
      {isUrgent && (
        <div className="absolute inset-0 bg-red-500/5 animate-pulse" />
      )}

      <div className="relative">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'p-1.5 rounded-lg',
                isUrgent ? 'bg-red-500/20' : 'bg-orange-500/20'
              )}
            >
              <AlertTriangle
                className={cn(
                  'h-5 w-5',
                  isUrgent ? 'text-red-400' : 'text-orange-400'
                )}
              />
            </div>
            <div>
              <h4
                className={cn(
                  'font-semibold text-sm',
                  isUrgent ? 'text-red-300' : 'text-orange-300'
                )}
              >
                Bottleneck Alert
              </h4>
              <p className="text-xs text-muted-foreground">
                This task blocks {blockedCount} other task
                {blockedCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          {/* View in graph button */}
          {onViewGraph && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onViewGraph}
              className={cn(
                'text-xs gap-1.5',
                isUrgent
                  ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
                  : 'text-orange-400 hover:text-orange-300 hover:bg-orange-500/10'
              )}
            >
              <Zap className="h-3.5 w-3.5" />
              View Graph
            </Button>
          )}
        </div>

        {/* Blocked tasks list */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ArrowRight className="h-3.5 w-3.5" />
            <span>Completing this will unblock:</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {blockedTasks.slice(0, 5).map((blocked) => (
              <Link
                key={blocked.id}
                to="/assistant/tasks/$taskId"
                params={{ taskId: blocked.id }}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded text-xs',
                  'bg-background/50 border border-border/50',
                  'hover:border-purple-500/50 hover:bg-purple-500/10 transition-colors'
                )}
              >
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    blocked.urgencyLevel === 'critical' && 'bg-red-500',
                    blocked.urgencyLevel === 'important' && 'bg-orange-500',
                    blocked.urgencyLevel === 'nice-to-have' && 'bg-yellow-500'
                  )}
                />
                <span className="max-w-[120px] truncate">{blocked.title}</span>
                <ChevronRight className="h-3 w-3 opacity-50" />
              </Link>
            ))}

            {blockedTasks.length > 5 && (
              <span className="inline-flex items-center px-2 py-1 rounded text-xs bg-muted text-muted-foreground">
                +{blockedTasks.length - 5} more
              </span>
            )}
          </div>
        </div>

        {/* Priority recommendation */}
        <div
          className={cn(
            'mt-3 pt-3 border-t flex items-center gap-2',
            isUrgent ? 'border-red-500/20' : 'border-orange-500/20'
          )}
        >
          <Zap
            className={cn(
              'h-4 w-4',
              isUrgent ? 'text-red-400' : 'text-orange-400'
            )}
          />
          <p
            className={cn(
              'text-xs font-medium',
              isUrgent ? 'text-red-300' : 'text-orange-300'
            )}
          >
            {isUrgent
              ? 'High priority - Complete this to unblock critical work'
              : 'Consider prioritizing to unblock more tasks'}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Compact bottleneck badge for task cards
 */
export function BottleneckBadge({
  count,
  className,
}: {
  count: number
  className?: string
}) {
  if (count === 0) return null

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold',
        'bg-orange-500/20 text-orange-400 border border-orange-500/30',
        className
      )}
      title={`Blocks ${count} task${count !== 1 ? 's' : ''}`}
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      {count}
    </span>
  )
}
