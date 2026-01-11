import { useState, useEffect } from 'react'
import { ParkingCircle, Loader2, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Task, ContextParkingInput } from '../types'

interface ContextParkingModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Task[]
  currentTaskId?: string
  onPark: (input: ContextParkingInput) => Promise<void>
}

/**
 * ContextParkingModal - Quick context capture modal
 * Opens with Cmd+P keyboard shortcut
 */
export function ContextParkingModal({
  open,
  onOpenChange,
  tasks,
  currentTaskId,
  onPark,
}: ContextParkingModalProps) {
  const [selectedTaskId, setSelectedTaskId] = useState(currentTaskId ?? '')
  const [content, setContent] = useState('')
  const [nextSteps, setNextSteps] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Get active tasks only
  const activeTasks = tasks.filter((t) => t.status !== 'completed')

  // Find selected task
  const selectedTask = activeTasks.find((t) => t.id === selectedTaskId)

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setSelectedTaskId(currentTaskId ?? activeTasks[0]?.id ?? '')
      setContent('')
      setNextSteps('')
    }
  }, [open, currentTaskId, activeTasks])

  async function handleSubmit() {
    if (!selectedTaskId || !content.trim()) return

    setIsSubmitting(true)
    try {
      await onPark({
        taskId: selectedTaskId,
        content: content.trim(),
        nextSteps: nextSteps.trim() || undefined,
      })

      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] bg-card border-purple-500/30">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <ParkingCircle className="h-5 w-5 text-purple-400" />
            Park Your Context
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Task selector */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Task</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between bg-background/50"
                >
                  {selectedTask ? (
                    <span className="truncate">{selectedTask.title}</span>
                  ) : (
                    <span className="text-muted-foreground">Select a task...</span>
                  )}
                  <ChevronDown className="h-4 w-4 ml-2 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[--radix-dropdown-menu-trigger-width]"
              >
                {activeTasks.length === 0 ? (
                  <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                    No active tasks
                  </div>
                ) : (
                  activeTasks.map((task) => (
                    <DropdownMenuItem
                      key={task.id}
                      onClick={() => setSelectedTaskId(task.id)}
                      className={cn(
                        'cursor-pointer',
                        task.id === selectedTaskId && 'bg-purple-500/10'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full',
                            task.urgencyLevel === 'critical' && 'bg-red-500',
                            task.urgencyLevel === 'important' && 'bg-orange-500',
                            task.urgencyLevel === 'nice-to-have' && 'bg-yellow-500'
                          )}
                        />
                        <span className="truncate">{task.title}</span>
                      </div>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Context content */}
          <div className="space-y-2">
            <Label htmlFor="context-content" className="text-sm font-medium">
              What were you working on? <span className="text-red-400">*</span>
            </Label>
            <Textarea
              id="context-content"
              value={content}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
              placeholder="I was debugging the auth middleware, found that the timeout is set to 5s in config..."
              className="bg-background/50 min-h-[100px] resize-none"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Capture your current thinking so you can resume later.
            </p>
          </div>

          {/* Next steps (optional) */}
          <div className="space-y-2">
            <Label htmlFor="next-steps" className="text-sm font-medium">
              What's the next step? <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="next-steps"
              value={nextSteps}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNextSteps(e.target.value)}
              placeholder="Check the worker pool size configuration..."
              className="bg-background/50 min-h-[60px] resize-none"
            />
          </div>
        </div>

        <DialogFooter className="pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!selectedTaskId || !content.trim() || isSubmitting}
            className="gap-2 bg-purple-600 hover:bg-purple-700"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Parking...
              </>
            ) : (
              <>
                <ParkingCircle className="h-4 w-4" />
                Park Context
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
