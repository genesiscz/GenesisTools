import { useState, useEffect } from 'react'
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { Task, DeadlineRisk } from '@/lib/assistant/types'
import { useDeadlineRisk } from '@/lib/assistant/hooks'
import { EscalationAlert } from './EscalationAlert'
import type { EscalationResolutionData } from './EscalationOptions'

interface EscalationWidgetProps {
  userId: string | null
  tasks: Task[]
  onResolve?: (taskId: string, data: EscalationResolutionData) => void
  className?: string
}

/**
 * EscalationWidget - Dashboard widget showing deadline risks at a glance
 *
 * Displays a compact alert when tasks are at risk:
 * - Yellow warning for at-risk tasks
 * - Red critical alert for high-risk tasks
 * - Clickable to open full escalation modal
 */
export function EscalationWidget({
  userId,
  tasks,
  onResolve,
  className,
}: EscalationWidgetProps) {
  const {
    risks,
    loading,
    calculateAllRisks,
    getHighRiskTasks,
    getMediumRiskTasks,
  } = useDeadlineRisk(userId)

  const [selectedRisk, setSelectedRisk] = useState<{
    task: Task
    risk: DeadlineRisk
  } | null>(null)

  // Calculate risks for all tasks with deadlines
  useEffect(() => {
    if (userId && tasks.length > 0) {
      calculateAllRisks(tasks)
    }
  }, [userId, tasks])

  const highRiskTasks = getHighRiskTasks()
  const mediumRiskTasks = getMediumRiskTasks()
  const totalAtRisk = highRiskTasks.length + mediumRiskTasks.length

  // Don't render if no risks or loading
  if (loading) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg',
          'bg-muted/50 border border-muted-foreground/20',
          className
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Checking risks...</span>
      </div>
    )
  }

  if (totalAtRisk === 0) {
    return null
  }

  const isCritical = highRiskTasks.length > 0
  const displayRisk = highRiskTasks[0] ?? mediumRiskTasks[0]
  const displayTask = tasks.find((t) => t.id === displayRisk?.taskId)

  function handleClick() {
    if (displayTask && displayRisk) {
      setSelectedRisk({ task: displayTask, risk: displayRisk })
    }
  }

  function handleResolve(taskId: string, data: EscalationResolutionData) {
    onResolve?.(taskId, data)
    setSelectedRisk(null)
  }

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          'group flex items-center gap-2 px-3 py-1.5 rounded-lg',
          'transition-all duration-200',
          'border',
          isCritical
            ? 'bg-red-500/10 border-red-500/30 hover:border-red-500/60'
            : 'bg-yellow-500/10 border-yellow-500/30 hover:border-yellow-500/60',
          isCritical
            ? 'shadow-sm hover:shadow-red-500/20'
            : 'shadow-sm hover:shadow-yellow-500/20',
          className
        )}
        style={{
          animation: isCritical ? 'pulse-glow-red 2s ease-in-out infinite' : undefined,
        }}
      >
        {/* Animated warning icon */}
        <div className="relative">
          <AlertTriangle
            className={cn(
              'h-4 w-4',
              isCritical ? 'text-red-400' : 'text-yellow-400',
              isCritical && 'animate-pulse'
            )}
          />
          {/* Critical glow ring */}
          {isCritical && (
            <div
              className="absolute -inset-1 rounded-full animate-ping opacity-30"
              style={{ background: 'radial-gradient(circle, rgba(239, 68, 68, 0.6) 0%, transparent 70%)' }}
            />
          )}
        </div>

        {/* Risk text */}
        <span
          className={cn(
            'text-sm font-medium',
            isCritical ? 'text-red-400' : 'text-yellow-400'
          )}
        >
          {totalAtRisk} deadline{totalAtRisk !== 1 ? 's' : ''} at risk
        </span>

        {/* Count breakdown */}
        <div className="flex items-center gap-1.5">
          {highRiskTasks.length > 0 && (
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-bold',
                'bg-red-500/20 text-red-400 border border-red-500/30'
              )}
            >
              {highRiskTasks.length} critical
            </span>
          )}
          {mediumRiskTasks.length > 0 && (
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[10px] font-bold',
                'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
              )}
            >
              {mediumRiskTasks.length} at risk
            </span>
          )}
        </div>

        {/* Arrow indicator */}
        <ChevronRight
          className={cn(
            'h-4 w-4 transition-transform',
            'group-hover:translate-x-0.5',
            isCritical ? 'text-red-400' : 'text-yellow-400'
          )}
        />
      </button>

      {/* Escalation modal */}
      {selectedRisk && (
        <EscalationAlert
          open={!!selectedRisk}
          onOpenChange={(open) => !open && setSelectedRisk(null)}
          task={selectedRisk.task}
          risk={selectedRisk.risk}
          onResolve={handleResolve}
        />
      )}

      {/* Keyframe animation for critical pulse */}
      <style>{`
        @keyframes pulse-glow-red {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
          }
          50% {
            box-shadow: 0 0 12px 2px rgba(239, 68, 68, 0.3);
          }
        }
      `}</style>
    </>
  )
}

/**
 * Compact risk summary for inline display
 */
export function RiskSummaryBadge({
  highRisk,
  mediumRisk,
  onClick,
  className,
}: {
  highRisk: number
  mediumRisk: number
  onClick?: () => void
  className?: string
}) {
  const total = highRisk + mediumRisk
  if (total === 0) return null

  const isCritical = highRisk > 0

  const Component = onClick ? 'button' : 'div'

  return (
    <Component
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-full',
        'text-xs font-medium',
        'border transition-all',
        isCritical
          ? 'bg-red-500/10 border-red-500/30 text-red-400'
          : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
        onClick && 'cursor-pointer hover:brightness-110',
        className
      )}
    >
      <AlertTriangle className={cn('h-3 w-3', isCritical && 'animate-pulse')} />
      <span>{total} at risk</span>
    </Component>
  )
}
