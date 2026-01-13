import { useDraggable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Link } from '@tanstack/react-router'
import { Calendar, Clock, GripVertical, AlertTriangle, AlertCircle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Task, UrgencyLevel } from '@/lib/assistant/types'

interface KanbanCardProps {
  task: Task
  isDragOverlay?: boolean
  className?: string
}

/**
 * Get urgency badge config
 */
function getUrgencyConfig(urgency: UrgencyLevel): {
  label: string
  icon: typeof AlertTriangle
  bgColor: string
  textColor: string
  borderColor: string
} {
  switch (urgency) {
    case 'critical':
      return {
        label: 'Critical',
        icon: AlertTriangle,
        bgColor: 'bg-red-500/15',
        textColor: 'text-red-400',
        borderColor: 'border-red-500/30',
      }
    case 'important':
      return {
        label: 'Important',
        icon: AlertCircle,
        bgColor: 'bg-orange-500/15',
        textColor: 'text-orange-400',
        borderColor: 'border-orange-500/30',
      }
    case 'nice-to-have':
      return {
        label: 'Nice to Have',
        icon: Sparkles,
        bgColor: 'bg-yellow-500/15',
        textColor: 'text-yellow-400',
        borderColor: 'border-yellow-500/30',
      }
  }
}

/**
 * Format relative time (e.g., "2 days", "5 hours")
 */
function formatDeadlineRelative(deadline: Date): { text: string; isOverdue: boolean } {
  const now = new Date()
  const diff = deadline.getTime() - now.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor(diff / (1000 * 60 * 60))

  if (diff < 0) {
    const absDays = Math.abs(days)
    if (absDays === 0) return { text: 'Overdue', isOverdue: true }
    return { text: `${absDays}d overdue`, isOverdue: true }
  }

  if (days === 0) {
    if (hours <= 1) return { text: 'Due soon', isOverdue: false }
    return { text: `${hours}h`, isOverdue: false }
  }

  return { text: `${days}d`, isOverdue: false }
}

/**
 * Format focus time
 */
function formatFocusTime(minutes: number): string {
  if (minutes === 0) return '--'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

/**
 * KanbanCard - Draggable task card for Kanban board
 */
export function KanbanCard({ task, isDragOverlay = false, className }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { task },
    disabled: isDragOverlay,
  })

  const urgencyConfig = getUrgencyConfig(task.urgencyLevel)
  const UrgencyIcon = urgencyConfig.icon
  const isCompleted = task.status === 'completed'
  const deadlineInfo = task.deadline
    ? formatDeadlineRelative(new Date(task.deadline))
    : null

  const style = {
    transform: CSS.Translate.toString(transform),
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        // Base styles
        'group relative rounded-lg border',
        'bg-[#0a0a14]/90 backdrop-blur-sm',
        'transition-all duration-200',
        // Border
        'border-white/10 hover:border-white/20',
        // Shadow
        'hover:shadow-lg hover:shadow-purple-500/10',
        // Drag states
        isDragging && 'opacity-50 scale-95',
        isDragOverlay && [
          'scale-105 rotate-2',
          'shadow-2xl shadow-purple-500/30',
          'border-purple-500/50',
          'cursor-grabbing',
        ],
        // Completed state
        isCompleted && 'opacity-60',
        className
      )}
      {...attributes}
      {...listeners}
    >
      {/* Drag handle indicator */}
      <div
        className={cn(
          'absolute left-1 top-1/2 -translate-y-1/2',
          'opacity-0 group-hover:opacity-40 transition-opacity',
          isDragOverlay && 'opacity-60'
        )}
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* Card content */}
      <div className="p-3 pl-5">
        {/* Urgency badge */}
        <div className="flex items-center justify-between mb-2">
          <span
            className={cn(
              'inline-flex items-center gap-1',
              'text-[9px] font-bold uppercase tracking-wider',
              'px-1.5 py-0.5 rounded',
              urgencyConfig.bgColor,
              urgencyConfig.textColor,
              'border',
              urgencyConfig.borderColor
            )}
          >
            <UrgencyIcon className="h-2.5 w-2.5" />
            {urgencyConfig.label}
          </span>

          {/* Shipping blocker indicator */}
          {task.isShippingBlocker && (
            <span className="text-[9px] font-bold text-red-400 uppercase tracking-wide">
              Blocker
            </span>
          )}
        </div>

        {/* Task title - clickable link */}
        <Link
          to="/assistant/tasks/$taskId"
          params={{ taskId: task.id }}
          className="group/link block"
          onClick={(e) => {
            // Prevent navigation during drag
            if (isDragging || isDragOverlay) {
              e.preventDefault()
            }
          }}
        >
          <h4
            className={cn(
              'text-sm font-medium leading-snug line-clamp-2',
              'transition-colors group-hover/link:text-purple-400',
              isCompleted && 'line-through text-muted-foreground'
            )}
          >
            {task.title}
          </h4>
        </Link>

        {/* Description preview */}
        {task.description && (
          <p className="text-[11px] text-muted-foreground line-clamp-1 mt-1">
            {task.description}
          </p>
        )}

        {/* Footer: Deadline + Focus time */}
        <div className="flex items-center justify-between mt-3 text-[10px] text-muted-foreground">
          {/* Deadline */}
          <div className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {deadlineInfo ? (
              <span
                className={cn(
                  deadlineInfo.isOverdue && 'text-red-400 font-medium'
                )}
              >
                {deadlineInfo.text}
              </span>
            ) : (
              <span>No deadline</span>
            )}
          </div>

          {/* Focus time */}
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            <span>{formatFocusTime(task.focusTimeLogged)}</span>
          </div>
        </div>

        {/* Context parking indicator */}
        {task.contextParkingLot && (
          <div className="mt-2 p-1.5 rounded bg-purple-500/10 border border-purple-500/20">
            <p className="text-[9px] text-purple-300 line-clamp-1">
              <span className="font-semibold">Parked:</span> {task.contextParkingLot}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * KanbanCardOverlay - The drag preview shown while dragging
 */
export function KanbanCardOverlay({ task }: { task: Task }) {
  return <KanbanCard task={task} isDragOverlay />
}
