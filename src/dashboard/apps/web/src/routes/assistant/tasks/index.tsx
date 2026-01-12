import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Plus, Loader2, ListTodo, Filter, Flame, ParkingCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { DashboardLayout } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { TaskCard, TaskForm, ContextParkingModal } from '@/lib/assistant/components'
import { useTaskStore, useContextParking } from '@/lib/assistant/hooks'
import type { TaskInput, ContextParkingInput, UrgencyLevel } from '@/lib/assistant/types'

export const Route = createFileRoute('/assistant/tasks/')({
  component: TasksPage,
})

type FilterMode = 'all' | 'active' | 'completed' | UrgencyLevel

function TasksPage() {
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null

  const {
    tasks,
    streak,
    loading,
    initialized,
    createTask,
    updateTask,
    deleteTask,
    completeTask,
    parkContext,
  } = useTaskStore(userId)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [filterMode, setFilterMode] = useState<FilterMode>('active')

  // Context parking modal with Cmd+P shortcut
  const contextParking = useContextParking()

  // Filter tasks based on current filter mode
  const filteredTasks = tasks.filter((task) => {
    switch (filterMode) {
      case 'all':
        return true
      case 'active':
        return task.status !== 'completed'
      case 'completed':
        return task.status === 'completed'
      case 'critical':
      case 'important':
      case 'nice-to-have':
        return task.urgencyLevel === filterMode && task.status !== 'completed'
      default:
        return true
    }
  })

  // Sort: critical first, then important, then nice-to-have, then by deadline
  const sortedTasks = [...filteredTasks].sort((a, b) => {
    // Completed tasks at the end
    if (a.status === 'completed' && b.status !== 'completed') return 1
    if (a.status !== 'completed' && b.status === 'completed') return -1

    // Urgency order
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

  // Counts for filter badges
  const counts = {
    all: tasks.length,
    active: tasks.filter((t) => t.status !== 'completed').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    critical: tasks.filter((t) => t.urgencyLevel === 'critical' && t.status !== 'completed')
      .length,
    important: tasks.filter((t) => t.urgencyLevel === 'important' && t.status !== 'completed')
      .length,
    'nice-to-have': tasks.filter(
      (t) => t.urgencyLevel === 'nice-to-have' && t.status !== 'completed'
    ).length,
  }

  // Handle task creation
  async function handleCreateTask(input: TaskInput) {
    await createTask(input)
  }

  // Handle task completion
  async function handleCompleteTask(taskId: string) {
    await completeTask(taskId)
  }

  // Handle start work
  async function handleStartWork(taskId: string) {
    await updateTask(taskId, { status: 'in-progress' })
  }

  // Handle task deletion
  async function handleDeleteTask(taskId: string) {
    await deleteTask(taskId)
  }

  // Handle context parking
  async function handleParkContext(input: ContextParkingInput) {
    await parkContext(input)
  }

  // Loading state
  if (authLoading || (!initialized && loading)) {
    return (
      <DashboardLayout title="Tasks" description="Manage your tasks">
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
            <span className="text-muted-foreground text-sm font-mono">Loading tasks...</span>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout title="Tasks" description="Manage your tasks with urgency-based prioritization">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          {/* Task counts */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">
              {counts.active} active task{counts.active !== 1 ? 's' : ''}
            </span>
            {counts.critical > 0 && (
              <span className="flex items-center gap-1 text-red-400 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                {counts.critical} critical
              </span>
            )}
          </div>

          {/* Streak indicator */}
          {streak && streak.currentStreakDays > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-orange-400">
              <Flame className="h-4 w-4" />
              <span className="font-semibold">{streak.currentStreakDays} day streak</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Park context button */}
          <Button
            variant="outline"
            size="sm"
            onClick={contextParking.open}
            className="gap-2"
            title="Park context (Cmd+P)"
          >
            <ParkingCircle className="h-4 w-4" />
            <span className="hidden sm:inline">Park</span>
            <kbd className="hidden lg:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              <span className="text-xs">Cmd</span>P
            </kbd>
          </Button>

          {/* Filter dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Filter className="h-4 w-4" />
                <span className="hidden sm:inline capitalize">
                  {filterMode === 'nice-to-have' ? 'Nice to Have' : filterMode}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setFilterMode('all')}>
                All ({counts.all})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFilterMode('active')}>
                Active ({counts.active})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFilterMode('completed')}>
                Completed ({counts.completed})
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Filter by Urgency</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setFilterMode('critical')}>
                <span className="h-2 w-2 rounded-full bg-red-500 mr-2" />
                Critical ({counts.critical})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFilterMode('important')}>
                <span className="h-2 w-2 rounded-full bg-orange-500 mr-2" />
                Important ({counts.important})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setFilterMode('nice-to-have')}>
                <span className="h-2 w-2 rounded-full bg-yellow-500 mr-2" />
                Nice to Have ({counts['nice-to-have']})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Create button */}
          <Button
            onClick={() => setCreateDialogOpen(true)}
            size="sm"
            className="gap-2 bg-purple-600 hover:bg-purple-700"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">Add Task</span>
          </Button>
        </div>
      </div>

      {/* Task grid */}
      {sortedTasks.length === 0 ? (
        <EmptyState filterMode={filterMode} onAddTask={() => setCreateDialogOpen(true)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 auto-rows-fr">
          {sortedTasks.map((task, index) => (
            <div
              key={task.id}
              className="animate-fade-in-up h-full"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <TaskCard
                task={task}
                onComplete={handleCompleteTask}
                onStartWork={handleStartWork}
                onDelete={handleDeleteTask}
                className="h-full"
              />
            </div>
          ))}
        </div>
      )}

      {/* Create task dialog */}
      <TaskForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={handleCreateTask}
      />

      {/* Context parking modal (Cmd+P) */}
      <ContextParkingModal
        open={contextParking.isOpen}
        onOpenChange={contextParking.setIsOpen}
        tasks={tasks}
        onPark={handleParkContext}
      />
    </DashboardLayout>
  )
}

/**
 * Empty state component
 */
function EmptyState({
  filterMode,
  onAddTask,
}: {
  filterMode: FilterMode
  onAddTask: () => void
}) {
  const getMessage = () => {
    switch (filterMode) {
      case 'completed':
        return {
          title: 'No completed tasks',
          description: 'Complete some tasks to see them here.',
        }
      case 'critical':
        return {
          title: 'No critical tasks',
          description: 'Great job! You have no critical tasks to worry about.',
        }
      case 'important':
        return {
          title: 'No important tasks',
          description: 'All important tasks are handled.',
        }
      case 'nice-to-have':
        return {
          title: 'No nice-to-have tasks',
          description: 'Add some stretch goals when you have time.',
        }
      default:
        return {
          title: 'No tasks yet',
          description: 'Create your first task to get started with urgency-based prioritization.',
        }
    }
  }

  const message = getMessage()

  return (
    <div className="flex flex-col items-center justify-center py-24 px-6">
      {/* Decorative element */}
      <div
        className={cn(
          'relative w-32 h-32 mb-8',
          'flex items-center justify-center',
          'rounded-full',
          'bg-gradient-to-br from-purple-500/10 to-purple-500/5',
          'border border-purple-500/20',
          'animate-pulse-glow'
        )}
      >
        <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple" />
        <div className="absolute inset-0 rounded-full border border-purple-500/20 animate-ripple-delayed" />
        <ListTodo className="h-12 w-12 text-purple-400/50" />
      </div>

      {/* Text */}
      <h2 className="text-xl font-semibold text-foreground/70 mb-2">{message.title}</h2>
      <p className="text-muted-foreground text-center max-w-md mb-8">{message.description}</p>

      {/* CTA Button */}
      {filterMode !== 'completed' && (
        <Button onClick={onAddTask} size="lg" className="gap-3 bg-purple-600 hover:bg-purple-700">
          <Plus className="h-5 w-5" />
          Create your first task
        </Button>
      )}
    </div>
  )
}
