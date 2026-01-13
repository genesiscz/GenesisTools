import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  MessageSquare,
  ArrowRight,
  Bell,
  CheckCircle,
  Calendar,
  Copy,
  Check,
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
import type { TaskBlocker } from '@/lib/assistant/types'

interface BlockerActionsProps {
  blocker: TaskBlocker
  onRemind?: (blocker: TaskBlocker) => void
  onSwitch?: () => void
  onSetReminder?: (blocker: TaskBlocker, date: Date) => void
  onResolve?: (blockerId: string) => void
  compact?: boolean
}

/**
 * Generate a draft reminder message for the blocker owner
 */
function generateReminderMessage(blocker: TaskBlocker): string {
  const owner = blocker.blockerOwner || 'there'
  const daysSince = Math.floor(
    (Date.now() - new Date(blocker.blockedSince).getTime()) / (1000 * 60 * 60 * 24)
  )

  return `Hey ${owner},

Just following up on a blocker that's been pending for ${daysSince === 0 ? 'today' : daysSince === 1 ? '1 day' : `${daysSince} days`}:

"${blocker.reason}"

Let me know if there's anything I can do to help move this forward, or if we need to discuss alternatives.

Thanks!`
}

/**
 * BlockerActions - Quick action buttons for a blocker
 *
 * Provides:
 * - Remind owner: Shows draft message to copy
 * - Switch task: Links to What's Next
 * - Set reminder: Date picker for follow-up
 * - Resolve: Mark blocker as resolved
 */
export function BlockerActions({
  blocker,
  onRemind: _onRemind,
  onSwitch: _onSwitch,
  onSetReminder,
  onResolve,
  compact = false,
}: BlockerActionsProps) {
  const [remindDialogOpen, setRemindDialogOpen] = useState(false)
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false)
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false)
  const [reminderDate, setReminderDate] = useState('')
  const [copied, setCopied] = useState(false)

  const draftMessage = generateReminderMessage(blocker)

  async function handleCopyMessage() {
    await navigator.clipboard.writeText(draftMessage)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleSetReminder() {
    if (reminderDate && onSetReminder) {
      onSetReminder(blocker, new Date(reminderDate))
      setReminderDialogOpen(false)
      setReminderDate('')
    }
  }

  function handleResolve() {
    if (onResolve) {
      onResolve(blocker.id)
      setResolveDialogOpen(false)
    }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {blocker.blockerOwner && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRemindDialogOpen(true)}
            className="h-7 px-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="h-7 px-2 text-xs text-purple-400 hover:text-purple-300 hover:bg-purple-500/10"
        >
          <Link to="/assistant/next">
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
        {onResolve && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setResolveDialogOpen(true)}
            className="h-7 px-2 text-xs text-green-400 hover:text-green-300 hover:bg-green-500/10"
          >
            <CheckCircle className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* Remind owner button */}
        {blocker.blockerOwner && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRemindDialogOpen(true)}
            className={cn(
              'gap-1.5 text-xs',
              'border-rose-500/30 hover:border-rose-500/50',
              'text-rose-400 hover:text-rose-300',
              'hover:bg-rose-500/10',
              'transition-all duration-200',
              'hover:shadow-[0_0_15px_rgba(244,63,94,0.2)]'
            )}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Remind {blocker.blockerOwner}
          </Button>
        )}

        {/* Switch task button */}
        <Button
          variant="outline"
          size="sm"
          asChild
          className={cn(
            'gap-1.5 text-xs',
            'border-purple-500/30 hover:border-purple-500/50',
            'text-purple-400 hover:text-purple-300',
            'hover:bg-purple-500/10',
            'transition-all duration-200',
            'hover:shadow-[0_0_15px_rgba(168,85,247,0.2)]'
          )}
        >
          <Link to="/assistant/next">
            <ArrowRight className="h-3.5 w-3.5" />
            Switch Task
          </Link>
        </Button>

        {/* Set reminder button */}
        {onSetReminder && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReminderDialogOpen(true)}
            className={cn(
              'gap-1.5 text-xs',
              'border-amber-500/30 hover:border-amber-500/50',
              'text-amber-400 hover:text-amber-300',
              'hover:bg-amber-500/10',
              'transition-all duration-200',
              'hover:shadow-[0_0_15px_rgba(245,158,11,0.2)]'
            )}
          >
            <Bell className="h-3.5 w-3.5" />
            Set Reminder
          </Button>
        )}

        {/* Resolve button */}
        {onResolve && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setResolveDialogOpen(true)}
            className={cn(
              'gap-1.5 text-xs',
              'border-green-500/30 hover:border-green-500/50',
              'text-green-400 hover:text-green-300',
              'hover:bg-green-500/10',
              'transition-all duration-200',
              'hover:shadow-[0_0_15px_rgba(34,197,94,0.2)]'
            )}
          >
            <CheckCircle className="h-3.5 w-3.5" />
            Resolve
          </Button>
        )}
      </div>

      {/* Remind Dialog */}
      <Dialog open={remindDialogOpen} onOpenChange={setRemindDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-rose-400" />
              Remind {blocker.blockerOwner}
            </DialogTitle>
            <DialogDescription>
              Copy this message to send to the blocker owner via Slack or email.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4">
            <Textarea
              value={draftMessage}
              readOnly
              className="min-h-[180px] font-mono text-sm bg-muted/50"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRemindDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCopyMessage}
              className="gap-2 bg-rose-600 hover:bg-rose-700"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy Message
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Reminder Dialog */}
      <Dialog open={reminderDialogOpen} onOpenChange={setReminderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-amber-400" />
              Set Reminder
            </DialogTitle>
            <DialogDescription>
              Set a date to be reminded about this blocker.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reminder-date">Reminder Date & Time</Label>
              <Input
                id="reminder-date"
                type="datetime-local"
                value={reminderDate}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReminderDate(e.target.value)}
                className="bg-background/50"
              />
            </div>

            {/* Quick presets */}
            <div className="flex flex-wrap gap-2">
              <QuickDateButton
                label="Tomorrow"
                onClick={() => {
                  const tomorrow = new Date()
                  tomorrow.setDate(tomorrow.getDate() + 1)
                  tomorrow.setHours(9, 0, 0, 0)
                  setReminderDate(formatDateTimeLocal(tomorrow))
                }}
              />
              <QuickDateButton
                label="In 2 days"
                onClick={() => {
                  const date = new Date()
                  date.setDate(date.getDate() + 2)
                  date.setHours(9, 0, 0, 0)
                  setReminderDate(formatDateTimeLocal(date))
                }}
              />
              <QuickDateButton
                label="Next week"
                onClick={() => {
                  const date = new Date()
                  date.setDate(date.getDate() + 7)
                  date.setHours(9, 0, 0, 0)
                  setReminderDate(formatDateTimeLocal(date))
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setReminderDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSetReminder}
              disabled={!reminderDate}
              className="gap-2 bg-amber-600 hover:bg-amber-700"
            >
              <Bell className="h-4 w-4" />
              Set Reminder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve Dialog */}
      <Dialog open={resolveDialogOpen} onOpenChange={setResolveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-400" />
              Resolve Blocker
            </DialogTitle>
            <DialogDescription>
              Mark this blocker as resolved. The task will be unblocked.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20">
            <p className="text-sm text-rose-200">{blocker.reason}</p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleResolve}
              className="gap-2 bg-green-600 hover:bg-green-700"
            >
              <CheckCircle className="h-4 w-4" />
              Resolve Blocker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Quick date preset button
 */
function QuickDateButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded text-xs font-medium',
        'bg-amber-500/10 border border-amber-500/20',
        'text-amber-400 hover:text-amber-300',
        'hover:bg-amber-500/20 hover:border-amber-500/30',
        'transition-all duration-200'
      )}
    >
      {label}
    </button>
  )
}

/**
 * Format date for datetime-local input
 */
function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}
