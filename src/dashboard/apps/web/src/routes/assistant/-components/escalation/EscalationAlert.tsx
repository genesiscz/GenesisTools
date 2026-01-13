import { useState } from 'react'
import {
  AlertTriangle,
  Calendar,
  Clock,
  TrendingDown,
  Percent,
  ChevronRight,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import type { Task, DeadlineRisk, DeadlineRiskOption } from '@/lib/assistant/types'
import { EscalationOptions, type EscalationResolutionData } from './EscalationOptions'

interface EscalationAlertProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task
  risk: DeadlineRisk
  onResolve: (taskId: string, data: EscalationResolutionData) => void
}

/**
 * Format a date for display
 */
function formatDate(date: Date | string): string {
  const d = new Date(date)
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Format days for display
 */
function formatDays(days: number): string {
  if (days === 0) return 'Today'
  if (days === 1) return '1 day'
  if (days === -1) return '1 day ago'
  if (days < 0) return `${Math.abs(days)} days ago`
  return `${days} days`
}

/**
 * EscalationAlert - Full modal for handling deadline risk
 *
 * Shows task details, risk assessment, and resolution options.
 * Provides a cyberpunk-styled interface with risk visualization.
 */
export function EscalationAlert({
  open,
  onOpenChange,
  task,
  risk,
  onResolve,
}: EscalationAlertProps) {
  const [selectedOption, setSelectedOption] = useState<DeadlineRiskOption | null>(null)

  function handleResolve(data: EscalationResolutionData) {
    onResolve(task.id, data)
    onOpenChange(false)
    setSelectedOption(null)
  }

  const isOverdue = risk.daysRemaining < 0
  const isCritical = risk.riskLevel === 'red'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'sm:max-w-[600px] border-2',
          isCritical
            ? 'border-red-500/50 shadow-lg shadow-red-500/20'
            : 'border-yellow-500/50 shadow-lg shadow-yellow-500/20'
        )}
      >
        {/* Custom header with risk indicator */}
        <DialogHeader className="space-y-3">
          <div className="flex items-start gap-3">
            {/* Animated risk icon */}
            <div
              className={cn(
                'relative p-3 rounded-xl',
                isCritical ? 'bg-red-500/10' : 'bg-yellow-500/10',
                'border',
                isCritical ? 'border-red-500/30' : 'border-yellow-500/30'
              )}
            >
              <AlertTriangle
                className={cn(
                  'h-6 w-6',
                  isCritical ? 'text-red-400' : 'text-yellow-400',
                  'animate-pulse'
                )}
              />
              {/* Glow effect for critical */}
              {isCritical && (
                <div
                  className="absolute inset-0 rounded-xl animate-ping"
                  style={{
                    background: 'radial-gradient(circle, rgba(239, 68, 68, 0.3) 0%, transparent 70%)',
                    animationDuration: '2s',
                  }}
                />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <DialogTitle
                className={cn(
                  'text-lg font-bold',
                  isCritical ? 'text-red-400' : 'text-yellow-400'
                )}
              >
                {isCritical ? 'Critical Deadline Risk' : 'Deadline At Risk'}
              </DialogTitle>
              <DialogDescription className="mt-1">
                This task needs attention to meet its deadline.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Task details card */}
        <div
          className={cn(
            'p-4 rounded-lg border',
            isCritical
              ? 'bg-red-500/5 border-red-500/20'
              : 'bg-yellow-500/5 border-yellow-500/20'
          )}
        >
          <h3 className="font-semibold text-base mb-3 line-clamp-2">
            {task.title}
          </h3>

          {/* Risk metrics grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Deadline */}
            <div className="flex items-center gap-2 p-2 rounded bg-background/50">
              <Calendar
                className={cn(
                  'h-4 w-4',
                  isOverdue ? 'text-red-400' : 'text-muted-foreground'
                )}
              />
              <div>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">
                  Deadline
                </p>
                <p
                  className={cn(
                    'text-sm font-medium',
                    isOverdue && 'text-red-400'
                  )}
                >
                  {task.deadline ? formatDate(task.deadline) : 'Not set'}
                </p>
              </div>
            </div>

            {/* Days remaining */}
            <div className="flex items-center gap-2 p-2 rounded bg-background/50">
              <Clock
                className={cn(
                  'h-4 w-4',
                  risk.daysRemaining <= 2 ? 'text-red-400' : 'text-muted-foreground'
                )}
              />
              <div>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">
                  Time Left
                </p>
                <p
                  className={cn(
                    'text-sm font-medium',
                    risk.daysRemaining <= 0 && 'text-red-400',
                    risk.daysRemaining > 0 && risk.daysRemaining <= 2 && 'text-yellow-400'
                  )}
                >
                  {formatDays(risk.daysRemaining)}
                </p>
              </div>
            </div>

            {/* Progress */}
            <div className="flex items-center gap-2 p-2 rounded bg-background/50">
              <Percent className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">
                  Progress
                </p>
                <p className="text-sm font-medium">
                  {Math.round(risk.percentComplete)}%
                </p>
              </div>
            </div>

            {/* Projected completion */}
            <div className="flex items-center gap-2 p-2 rounded bg-background/50">
              <TrendingDown
                className={cn(
                  'h-4 w-4',
                  risk.daysLate > 0 ? 'text-red-400' : 'text-green-400'
                )}
              />
              <div>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">
                  Projected
                </p>
                <p
                  className={cn(
                    'text-sm font-medium',
                    risk.daysLate > 0 && 'text-red-400'
                  )}
                >
                  {formatDate(risk.projectedCompletionDate)}
                </p>
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-3">
            <div className="h-2 bg-background/50 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  risk.percentComplete < 30 && 'bg-red-500',
                  risk.percentComplete >= 30 && risk.percentComplete < 70 && 'bg-yellow-500',
                  risk.percentComplete >= 70 && 'bg-green-500'
                )}
                style={{ width: `${risk.percentComplete}%` }}
              />
            </div>
          </div>

          {/* Days late indicator */}
          {risk.daysLate > 0 && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-red-400 font-medium">
                Projected {risk.daysLate} day{risk.daysLate !== 1 ? 's' : ''} late
              </span>
            </div>
          )}
        </div>

        {/* Resolution options */}
        <div className="mt-2">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <ChevronRight className="h-4 w-4 text-purple-400" />
            Choose Resolution
          </h4>
          <EscalationOptions
            recommendedOption={risk.recommendedOption}
            selectedOption={selectedOption}
            onSelectOption={setSelectedOption}
            onConfirm={handleResolve}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
