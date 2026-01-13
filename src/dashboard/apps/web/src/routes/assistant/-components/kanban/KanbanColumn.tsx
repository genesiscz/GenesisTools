import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import type { Task, TaskStatus } from '@/lib/assistant/types'
import { KanbanHeader, COLUMN_CONFIG } from './KanbanHeader'
import { KanbanCard } from './KanbanCard'

interface KanbanColumnProps {
  status: TaskStatus
  tasks: Task[]
  onAddTask?: (status: TaskStatus) => void
  className?: string
}

/**
 * KanbanColumn - Droppable column container for tasks
 */
export function KanbanColumn({ status, tasks, onAddTask, className }: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: status,
    data: { status },
  })

  const config = COLUMN_CONFIG[status]

  // Sort tasks by urgency (critical first), then by deadline
  const sortedTasks = [...tasks].sort((a, b) => {
    const urgencyOrder = { critical: 0, important: 1, 'nice-to-have': 2 }
    const urgencyDiff = urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel]
    if (urgencyDiff !== 0) return urgencyDiff

    // Deadline (earlier first, no deadline last)
    if (a.deadline && b.deadline) {
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime()
    }
    if (a.deadline) return -1
    if (b.deadline) return 1

    // Updated at (most recent first)
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })

  return (
    <div
      className={cn(
        // Base styles
        'flex flex-col',
        'min-w-[280px] w-[280px] md:min-w-[300px] md:w-[300px]',
        'h-full max-h-[calc(100vh-220px)]',
        'rounded-lg',
        // Glassmorphism
        'bg-[#0a0a14]/40 backdrop-blur-md',
        'border',
        config.borderColor,
        // Neon glow on hover
        'transition-all duration-300',
        `hover:shadow-lg hover:${config.glowColor}`,
        // Drop target highlight
        isOver && [
          'ring-2',
          status === 'backlog' && 'ring-cyan-500/50',
          status === 'in-progress' && 'ring-amber-500/50',
          status === 'blocked' && 'ring-rose-500/50',
          status === 'completed' && 'ring-emerald-500/50',
          'scale-[1.02]',
        ],
        className
      )}
    >
      {/* Tech corner decorations */}
      <div
        className={cn(
          'absolute top-0 left-0 w-4 h-4 border-l-2 border-t-2 rounded-tl transition-colors',
          config.borderColor
        )}
      />
      <div
        className={cn(
          'absolute top-0 right-0 w-4 h-4 border-r-2 border-t-2 rounded-tr transition-colors',
          config.borderColor
        )}
      />
      <div
        className={cn(
          'absolute bottom-0 left-0 w-4 h-4 border-l-2 border-b-2 rounded-bl transition-colors',
          config.borderColor
        )}
      />
      <div
        className={cn(
          'absolute bottom-0 right-0 w-4 h-4 border-r-2 border-b-2 rounded-br transition-colors',
          config.borderColor
        )}
      />

      {/* Column header */}
      <KanbanHeader
        status={status}
        count={tasks.length}
        onAddTask={onAddTask ? () => onAddTask(status) : undefined}
      />

      {/* Scrollable task list */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden',
          'p-2 space-y-2',
          // Drop zone visual
          isOver && config.bgColor,
          'transition-colors duration-200',
          // Custom scrollbar
          'scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent'
        )}
      >
        {sortedTasks.length > 0 ? (
          sortedTasks.map((task) => <KanbanCard key={task.id} task={task} />)
        ) : (
          <EmptyColumn status={status} isOver={isOver} />
        )}
      </div>
    </div>
  )
}

/**
 * Empty column placeholder
 */
function EmptyColumn({ status, isOver }: { status: TaskStatus; isOver: boolean }) {
  const config = COLUMN_CONFIG[status]

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center',
        'h-24 rounded-lg border-2 border-dashed',
        'transition-all duration-200',
        isOver ? [config.borderColor, config.bgColor] : 'border-white/10',
        isOver && 'scale-105'
      )}
    >
      <p
        className={cn(
          'text-xs font-medium',
          isOver ? config.textColor : 'text-muted-foreground/50'
        )}
      >
        {isOver ? 'Drop here' : 'No tasks'}
      </p>
    </div>
  )
}
