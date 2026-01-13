/**
 * PathAnalysis - Analysis panel for critical path visualization
 *
 * Shows:
 * - Critical path sequence
 * - Days to completion estimate
 * - Bottleneck warnings
 * - Task statistics
 */

import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle,
  ChevronRight,
  Clock,
  GitBranch,
  Target,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import type { CriticalPathAnalysis } from './types'
import type { Task } from '@/lib/assistant/types'

interface PathAnalysisProps {
  analysis: CriticalPathAnalysis
  onTaskClick?: (taskId: string) => void
  className?: string
}

/**
 * Get urgency color classes
 */
function getUrgencyColors(urgency: Task['urgencyLevel']): {
  bg: string
  text: string
  border: string
} {
  switch (urgency) {
    case 'critical':
      return {
        bg: 'bg-red-500/10',
        text: 'text-red-400',
        border: 'border-red-500/30',
      }
    case 'important':
      return {
        bg: 'bg-orange-500/10',
        text: 'text-orange-400',
        border: 'border-orange-500/30',
      }
    case 'nice-to-have':
      return {
        bg: 'bg-yellow-500/10',
        text: 'text-yellow-400',
        border: 'border-yellow-500/30',
      }
  }
}

export function PathAnalysis({
  analysis,
  onTaskClick,
  className,
}: PathAnalysisProps) {
  const {
    criticalPath,
    daysToCompletion,
    bottlenecks,
    totalTasks,
    rootTasks,
    leafTasks,
    maxDepth,
  } = analysis

  const hasCriticalPath = criticalPath.length > 0
  const hasBottlenecks = bottlenecks.length > 0

  return (
    <div className={cn('space-y-4', className)}>
      {/* Summary Stats */}
      <FeatureCard color="purple">
        <FeatureCardHeader className="pb-3">
          <div className="flex items-center gap-2 mb-3">
            <Target className="h-5 w-5 text-purple-400" />
            <h3 className="font-semibold">Path Analysis</h3>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <StatBox
              icon={Clock}
              label="Est. Days"
              value={daysToCompletion}
              color="purple"
            />
            <StatBox
              icon={GitBranch}
              label="Max Depth"
              value={maxDepth}
              color="blue"
            />
            <StatBox
              icon={Zap}
              label="Active Tasks"
              value={totalTasks}
              color="cyan"
            />
            <StatBox
              icon={CheckCircle}
              label="Leaf Tasks"
              value={leafTasks}
              color="green"
            />
          </div>
        </FeatureCardHeader>
      </FeatureCard>

      {/* Critical Path */}
      {hasCriticalPath && (
        <FeatureCard color="rose">
          <FeatureCardHeader className="pb-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative">
                <ArrowRight className="h-5 w-5 text-red-400" />
                <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              </div>
              <h3 className="font-semibold text-red-300">Critical Path</h3>
              <span className="text-xs text-red-400/70">
                ({criticalPath.length} task{criticalPath.length !== 1 ? 's' : ''})
              </span>
            </div>

            <div className="space-y-2">
              {criticalPath.map((task, index) => {
                const colors = getUrgencyColors(task.urgencyLevel)
                const isLast = index === criticalPath.length - 1

                return (
                  <div key={task.id} className="flex items-center gap-2">
                    {/* Step indicator */}
                    <div className="flex flex-col items-center">
                      <div
                        className={cn(
                          'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
                          'bg-red-500/20 text-red-400 border border-red-500/40'
                        )}
                      >
                        {index + 1}
                      </div>
                      {!isLast && (
                        <div className="w-0.5 h-4 bg-red-500/30" />
                      )}
                    </div>

                    {/* Task button */}
                    <button
                      onClick={() => onTaskClick?.(task.id)}
                      className={cn(
                        'flex-1 text-left p-2 rounded-lg border transition-all',
                        'hover:brightness-125',
                        colors.bg,
                        colors.border
                      )}
                    >
                      <p className="text-sm font-medium line-clamp-1">
                        {task.title}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={cn(
                            'text-[10px] font-semibold uppercase',
                            colors.text
                          )}
                        >
                          {task.urgencyLevel}
                        </span>
                        {task.deadline && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Calendar className="h-2.5 w-2.5" />
                            {new Date(task.deadline).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                            })}
                          </span>
                        )}
                      </div>
                    </button>
                  </div>
                )
              })}
            </div>

            {/* Path summary */}
            <div className="mt-3 pt-3 border-t border-red-500/20">
              <div className="flex items-center gap-2 text-xs text-red-300/80">
                <Clock className="h-3.5 w-3.5" />
                <span>
                  Complete this path to ship in ~{daysToCompletion} days
                </span>
              </div>
            </div>
          </FeatureCardHeader>
        </FeatureCard>
      )}

      {/* No critical path message */}
      {!hasCriticalPath && (
        <FeatureCard color="emerald">
          <FeatureCardHeader>
            <div className="flex items-center gap-2 text-green-400">
              <CheckCircle className="h-5 w-5" />
              <h3 className="font-semibold">No Dependencies</h3>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              Your tasks are independent. Work on any task in any order!
            </p>
          </FeatureCardHeader>
        </FeatureCard>
      )}

      {/* Bottlenecks */}
      {hasBottlenecks && (
        <FeatureCard color="amber">
          <FeatureCardHeader className="pb-3">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-orange-400" />
              <h3 className="font-semibold text-orange-300">Bottlenecks</h3>
            </div>

            <p className="text-xs text-muted-foreground mb-3">
              These tasks block multiple other tasks. Prioritize them to unblock
              more work.
            </p>

            <div className="space-y-2">
              {bottlenecks.slice(0, 3).map((task) => {
                const colors = getUrgencyColors(task.urgencyLevel)

                return (
                  <button
                    key={task.id}
                    onClick={() => onTaskClick?.(task.id)}
                    className={cn(
                      'w-full flex items-center justify-between p-2 rounded-lg border transition-all',
                      'hover:brightness-125',
                      colors.bg,
                      colors.border
                    )}
                  >
                    <div className="text-left">
                      <p className="text-sm font-medium line-clamp-1">
                        {task.title}
                      </p>
                      <span
                        className={cn(
                          'text-[10px] font-semibold uppercase',
                          colors.text
                        )}
                      >
                        {task.urgencyLevel}
                      </span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                )
              })}
            </div>
          </FeatureCardHeader>
        </FeatureCard>
      )}

      {/* Quick Actions */}
      <div className="flex gap-2">
        <Button
          asChild
          variant="outline"
          size="sm"
          className="flex-1 text-xs"
        >
          <Link to="/assistant/tasks">View All Tasks</Link>
        </Button>
        {hasCriticalPath && criticalPath[0] && (
          <Button
            size="sm"
            className="flex-1 text-xs bg-red-600 hover:bg-red-700"
            onClick={() => onTaskClick?.(criticalPath[0].id)}
          >
            Start Critical Task
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Stat box component
 */
function StatBox({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ElementType
  label: string
  value: number
  color: 'purple' | 'blue' | 'cyan' | 'green' | 'red' | 'orange'
}) {
  const colorClasses = {
    purple: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
    blue: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
    cyan: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
    green: 'text-green-400 bg-green-500/10 border-green-500/30',
    red: 'text-red-400 bg-red-500/10 border-red-500/30',
    orange: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  }

  return (
    <div
      className={cn(
        'p-2 rounded-lg border text-center',
        colorClasses[color]
      )}
    >
      <Icon className="h-4 w-4 mx-auto mb-1 opacity-70" />
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[10px] opacity-70">{label}</div>
    </div>
  )
}
