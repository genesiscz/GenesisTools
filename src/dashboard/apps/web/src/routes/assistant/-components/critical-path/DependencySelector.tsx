/**
 * DependencySelector - Task dependency picker for task detail page
 *
 * Allows users to:
 * - Select which tasks the current task depends on
 * - See which tasks are blocked by the current task
 * - Prevent circular dependencies
 */

import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Plus,
  Search,
  X,
  AlertTriangle,
  CheckCircle,
  Circle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { Task } from '@/lib/assistant/types'
import { wouldCreateCycle } from './graph-utils'

interface DependencySelectorProps {
  taskId: string
  currentDependencies: string[]
  allTasks: Task[]
  onUpdate: (dependencies: string[]) => void
  className?: string
}

/**
 * Get urgency color for task chip
 */
function getUrgencyChipColors(urgency: Task['urgencyLevel']): string {
  switch (urgency) {
    case 'critical':
      return 'bg-red-500/20 text-red-400 border-red-500/30'
    case 'important':
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30'
    case 'nice-to-have':
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  }
}

/**
 * Get status icon
 */
function getStatusIcon(status: Task['status']) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="h-3 w-3 text-green-400" />
    default:
      return <Circle className="h-3 w-3 text-gray-400" />
  }
}

export function DependencySelector({
  taskId,
  currentDependencies,
  allTasks,
  onUpdate,
  className,
}: DependencySelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Get the dependency tasks
  const dependencyTasks = currentDependencies
    .map((id) => allTasks.find((t) => t.id === id))
    .filter((t): t is Task => t !== undefined)

  // Get tasks that are blocked by this task
  const blockedTasks = allTasks.filter(
    (t) => t.blockedBy?.includes(taskId) && t.id !== taskId
  )

  // Available tasks for selection (not self, not already selected, not completed)
  const availableTasks = allTasks.filter(
    (t) =>
      t.id !== taskId &&
      !currentDependencies.includes(t.id) &&
      t.status !== 'completed'
  )

  // Filter by search query
  const filteredTasks = searchQuery
    ? availableTasks.filter((t) =>
        t.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : availableTasks

  function handleAddDependency(depId: string) {
    // Check for cycle
    if (wouldCreateCycle(allTasks, depId, taskId)) {
      // Could show a toast here
      return
    }

    onUpdate([...currentDependencies, depId])
  }

  function handleRemoveDependency(depId: string) {
    onUpdate(currentDependencies.filter((id) => id !== depId))
  }

  function checkWouldCreateCycle(depId: string): boolean {
    return wouldCreateCycle(allTasks, depId, taskId)
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Depends On Section */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm font-medium flex items-center gap-1.5">
            <ArrowLeft className="h-4 w-4 text-purple-400" />
            Depends On
          </Label>
          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Add Dependency</DialogTitle>
              </DialogHeader>

              {/* Search input */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search tasks..."
                  value={searchQuery}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setSearchQuery(e.target.value)
                  }
                  className="pl-9"
                />
              </div>

              {/* Task list */}
              <div className="max-h-64 overflow-y-auto space-y-1">
                {filteredTasks.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No available tasks
                  </p>
                ) : (
                  filteredTasks.map((task) => {
                    const wouldCycle = checkWouldCreateCycle(task.id)
                    const colors = getUrgencyChipColors(task.urgencyLevel)

                    return (
                      <button
                        key={task.id}
                        onClick={() => {
                          if (!wouldCycle) {
                            handleAddDependency(task.id)
                            setIsOpen(false)
                            setSearchQuery('')
                          }
                        }}
                        disabled={wouldCycle}
                        className={cn(
                          'w-full flex items-center justify-between p-2 rounded-lg border transition-all text-left',
                          wouldCycle
                            ? 'opacity-50 cursor-not-allowed bg-muted/20 border-muted'
                            : 'hover:bg-muted/50 border-border/50 hover:border-purple-500/50'
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(task.status)}
                            <span className="text-sm font-medium truncate">
                              {task.title}
                            </span>
                          </div>
                          <span
                            className={cn(
                              'text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded mt-1 inline-block',
                              colors
                            )}
                          >
                            {task.urgencyLevel}
                          </span>
                        </div>

                        {wouldCycle ? (
                          <span className="flex items-center gap-1 text-xs text-red-400">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Cycle
                          </span>
                        ) : (
                          <Plus className="h-4 w-4 text-muted-foreground" />
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Current dependencies */}
        {dependencyTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No dependencies. This task can start anytime.
          </p>
        ) : (
          <div className="space-y-1.5">
            {dependencyTasks.map((task) => {
              const colors = getUrgencyChipColors(task.urgencyLevel)
              const isCompleted = task.status === 'completed'

              return (
                <div
                  key={task.id}
                  className={cn(
                    'flex items-center justify-between p-2 rounded-lg border',
                    isCompleted
                      ? 'bg-green-500/5 border-green-500/20'
                      : 'bg-muted/30 border-border/50'
                  )}
                >
                  <Link
                    to="/assistant/tasks/$taskId"
                    params={{ taskId: task.id }}
                    className="flex items-center gap-2 flex-1 min-w-0 hover:text-purple-400 transition-colors"
                  >
                    {isCompleted ? (
                      <CheckCircle className="h-3.5 w-3.5 text-green-400 shrink-0" />
                    ) : (
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          task.urgencyLevel === 'critical' && 'bg-red-500',
                          task.urgencyLevel === 'important' && 'bg-orange-500',
                          task.urgencyLevel === 'nice-to-have' && 'bg-yellow-500'
                        )}
                      />
                    )}
                    <span className="text-sm truncate">{task.title}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </Link>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveDependency(task.id)}
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Blocks Section (read-only) */}
      <div>
        <Label className="text-sm font-medium flex items-center gap-1.5 mb-2">
          <ArrowRight className="h-4 w-4 text-orange-400" />
          Blocks
        </Label>

        {blockedTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This task doesn't block any other tasks.
          </p>
        ) : (
          <div className="space-y-1.5">
            {blockedTasks.map((task) => (
              <Link
                key={task.id}
                to="/assistant/tasks/$taskId"
                params={{ taskId: task.id }}
                className={cn(
                  'flex items-center justify-between p-2 rounded-lg border',
                  'bg-orange-500/5 border-orange-500/20',
                  'hover:bg-orange-500/10 hover:border-orange-500/30 transition-colors'
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      task.urgencyLevel === 'critical' && 'bg-red-500',
                      task.urgencyLevel === 'important' && 'bg-orange-500',
                      task.urgencyLevel === 'nice-to-have' && 'bg-yellow-500'
                    )}
                  />
                  <span className="text-sm">{task.title}</span>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Link to critical path view */}
      <Button
        asChild
        variant="outline"
        size="sm"
        className="w-full text-xs gap-1.5"
      >
        <Link to="/assistant/next">
          View in Critical Path
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  )
}
