import { Link } from '@tanstack/react-router'
import {
  Clock,
  User,
  AlertTriangle,
  Bell,
  ArrowRight,
  Timer,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import type { TaskBlocker, Task, BlockerFollowUpAction } from '@/lib/assistant/types'
import { BlockerActions } from './BlockerActions'

interface BlockerCardProps {
  blocker: TaskBlocker
  task?: Task
  onRemind?: (blocker: TaskBlocker) => void
  onSwitch?: () => void
  onSetReminder?: (blocker: TaskBlocker, date: Date) => void
  onResolve?: (blockerId: string) => void
  className?: string
}

/**
 * Format time blocked in human-readable form
 */
function formatTimeBlocked(blockedSince: Date): string {
  const now = new Date()
  const diff = now.getTime() - new Date(blockedSince).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (days === 0) {
    if (hours === 0) return 'Just now'
    if (hours === 1) return '1 hour ago'
    return `${hours} hours ago`
  }
  if (days === 1) return '1 day ago'
  if (days < 7) return `${days} days ago`
  if (days < 14) return '1 week ago'
  return `${Math.floor(days / 7)} weeks ago`
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
 * Get follow-up action display info
 */
function getFollowUpInfo(action?: BlockerFollowUpAction): {
  icon: typeof Bell
  label: string
  colorClass: string
} | null {
  if (!action) return null

  switch (action) {
    case 'remind':
      return { icon: Bell, label: 'Remind owner', colorClass: 'text-blue-400' }
    case 'switch':
      return { icon: ArrowRight, label: 'Switch task', colorClass: 'text-purple-400' }
    case 'wait':
      return { icon: Timer, label: 'Waiting', colorClass: 'text-amber-400' }
  }
}

/**
 * BlockerCard - Displays a single blocker with time blocked and quick actions
 *
 * Uses rose/red color theme with cyberpunk aesthetic.
 * Pulses for long-standing blockers (>2 days).
 */
export function BlockerCard({
  blocker,
  task,
  onRemind,
  onSwitch,
  onSetReminder,
  onResolve,
  className,
}: BlockerCardProps) {
  const urgency = getBlockerUrgency(new Date(blocker.blockedSince))
  const followUpInfo = getFollowUpInfo(blocker.followUpAction)
  const FollowUpIcon = followUpInfo?.icon

  return (
    <FeatureCard
      color="rose"
      className={cn(
        'relative overflow-hidden transition-all duration-300',
        urgency === 'critical' && 'ring-2 ring-rose-500/50',
        className
      )}
    >
      {/* Pulsing indicator for critical blockers */}
      {urgency === 'critical' && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-rose-500 via-red-500 to-rose-500 animate-pulse" />
      )}

      <FeatureCardHeader className="pb-2">
        {/* Header: Time blocked + urgency indicator */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'relative h-2 w-2 rounded-full',
                urgency === 'normal' && 'bg-rose-400',
                urgency === 'warning' && 'bg-rose-500',
                urgency === 'critical' && 'bg-red-500'
              )}
            >
              {urgency === 'critical' && (
                <span className="absolute inset-0 rounded-full bg-red-500 animate-ping" />
              )}
            </div>
            <Clock className="h-3.5 w-3.5 text-rose-400" />
            <span
              className={cn(
                'text-xs font-medium',
                urgency === 'normal' && 'text-rose-300',
                urgency === 'warning' && 'text-rose-400',
                urgency === 'critical' && 'text-red-400'
              )}
            >
              Blocked {formatTimeBlocked(new Date(blocker.blockedSince))}
            </span>
          </div>

          {/* Follow-up action badge */}
          {followUpInfo && FollowUpIcon && (
            <span
              className={cn(
                'flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide',
                'bg-rose-500/10 border border-rose-500/20',
                followUpInfo.colorClass
              )}
            >
              <FollowUpIcon className="h-3 w-3" />
              {followUpInfo.label}
            </span>
          )}
        </div>

        {/* Task title - linked if task exists */}
        {task ? (
          <Link
            to="/assistant/tasks/$taskId"
            params={{ taskId: task.id }}
            className="group/link"
          >
            <h3 className="text-sm font-semibold leading-snug line-clamp-1 transition-colors group-hover/link:text-rose-400">
              {task.title}
            </h3>
          </Link>
        ) : (
          <h3 className="text-sm font-semibold leading-snug line-clamp-1 text-muted-foreground">
            Unknown Task
          </h3>
        )}

        {/* Blocker reason */}
        <div className="mt-2 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-rose-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-rose-200 line-clamp-2">{blocker.reason}</p>
          </div>
        </div>

        {/* Blocker owner */}
        {blocker.blockerOwner && (
          <div className="flex items-center gap-1.5 mt-2">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Blocked by{' '}
              <span className="text-rose-300 font-medium">{blocker.blockerOwner}</span>
            </span>
          </div>
        )}

        {/* Reminder set indicator */}
        {blocker.reminderSet && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <Bell className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs text-amber-300">
              Reminder: {new Date(blocker.reminderSet).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          </div>
        )}
      </FeatureCardHeader>

      <FeatureCardContent className="pt-2">
        <BlockerActions
          blocker={blocker}
          onRemind={onRemind}
          onSwitch={onSwitch}
          onSetReminder={onSetReminder}
          onResolve={onResolve}
        />
      </FeatureCardContent>
    </FeatureCard>
  )
}
