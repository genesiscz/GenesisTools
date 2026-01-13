import { useState } from 'react'
import {
  AlertTriangle,
  User,
  Bell,
  ArrowRight,
  Timer,
  Ban,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import type { Task, TaskBlockerInput, BlockerFollowUpAction } from '@/lib/assistant/types'

interface BlockerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task | null
  onSubmit: (input: TaskBlockerInput) => Promise<void>
}

/**
 * Follow-up action configuration
 */
const followUpActions: {
  value: BlockerFollowUpAction
  label: string
  description: string
  icon: typeof Bell
  colorClass: string
}[] = [
  {
    value: 'remind',
    label: 'Remind Owner',
    description: 'I need to follow up with someone',
    icon: Bell,
    colorClass: 'text-blue-400 border-blue-500/30 hover:border-blue-500/50 hover:bg-blue-500/10',
  },
  {
    value: 'switch',
    label: 'Switch Task',
    description: 'I should work on something else',
    icon: ArrowRight,
    colorClass: 'text-purple-400 border-purple-500/30 hover:border-purple-500/50 hover:bg-purple-500/10',
  },
  {
    value: 'wait',
    label: 'Wait',
    description: 'Nothing I can do, just waiting',
    icon: Timer,
    colorClass: 'text-amber-400 border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-500/10',
  },
]

/**
 * BlockerModal - Dialog for marking a task as blocked
 *
 * Captures:
 * - Blocker reason (required)
 * - Blocker owner (optional, e.g., "@sarah")
 * - Follow-up action (remind/switch/wait)
 */
export function BlockerModal({
  open,
  onOpenChange,
  task,
  onSubmit,
}: BlockerModalProps) {
  const [reason, setReason] = useState('')
  const [blockerOwner, setBlockerOwner] = useState('')
  const [followUpAction, setFollowUpAction] = useState<BlockerFollowUpAction | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      // Reset form when closing
      setReason('')
      setBlockerOwner('')
      setFollowUpAction(null)
    }
    onOpenChange(newOpen)
  }

  async function handleSubmit() {
    if (!task || !reason.trim()) return

    setIsSubmitting(true)
    try {
      await onSubmit({
        taskId: task.id,
        reason: reason.trim(),
        blockerOwner: blockerOwner.trim() || undefined,
        followUpAction: followUpAction || undefined,
      })
      handleOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
              <Ban className="h-5 w-5 text-rose-400" />
            </div>
            Mark as Blocked
          </DialogTitle>
          <DialogDescription>
            {task ? (
              <>
                Record why <span className="font-medium text-foreground">{task.title}</span> is blocked.
              </>
            ) : (
              'Record why this task is blocked.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {/* Blocker reason */}
          <div className="space-y-2">
            <Label htmlFor="blocker-reason" className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              What's blocking this task?
              <span className="text-rose-400">*</span>
            </Label>
            <Textarea
              id="blocker-reason"
              value={reason}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
              placeholder="e.g., Waiting for API documentation from backend team"
              className="min-h-[80px] resize-none bg-background/50"
            />
          </div>

          {/* Blocker owner */}
          <div className="space-y-2">
            <Label htmlFor="blocker-owner" className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              Who's responsible for unblocking?
              <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="blocker-owner"
              value={blockerOwner}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBlockerOwner(e.target.value)}
              placeholder="e.g., @sarah or Backend Team"
              className="bg-background/50"
            />
          </div>

          {/* Follow-up action */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              What's your next step?
              <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {followUpActions.map((action) => {
                const Icon = action.icon
                const isSelected = followUpAction === action.value

                return (
                  <button
                    key={action.value}
                    type="button"
                    onClick={() =>
                      setFollowUpAction(isSelected ? null : action.value)
                    }
                    className={cn(
                      'p-3 rounded-lg border transition-all text-center',
                      'border-border hover:border-rose-500/30',
                      isSelected && action.colorClass,
                      isSelected && 'ring-2 ring-offset-2 ring-offset-background',
                      isSelected && action.value === 'remind' && 'ring-blue-500/50',
                      isSelected && action.value === 'switch' && 'ring-purple-500/50',
                      isSelected && action.value === 'wait' && 'ring-amber-500/50'
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-5 w-5 mx-auto mb-1',
                        isSelected ? action.colorClass.split(' ')[0] : 'text-muted-foreground'
                      )}
                    />
                    <span
                      className={cn(
                        'text-xs font-medium',
                        isSelected ? action.colorClass.split(' ')[0] : 'text-muted-foreground'
                      )}
                    >
                      {action.label}
                    </span>
                  </button>
                )
              })}
            </div>
            {followUpAction && (
              <p className="text-xs text-muted-foreground mt-1">
                {followUpActions.find((a) => a.value === followUpAction)?.description}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!reason.trim() || isSubmitting}
            className="gap-2 bg-rose-600 hover:bg-rose-700"
          >
            <Ban className="h-4 w-4" />
            {isSubmitting ? 'Marking...' : 'Mark as Blocked'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
