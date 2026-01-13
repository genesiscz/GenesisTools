import { useState, useEffect } from 'react'
import {
  FileText,
  Plus,
  X,
  Trash2,
  GripVertical,
  Terminal,
  Scale,
  Ban,
  ListChecks,
  AlertTriangle,
  Phone,
  User,
  Eye,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from '@/components/ui/sheet'
import type { Task, Decision, TaskBlocker, ContextParking, HandoffDocumentInput } from '@/lib/assistant/types'
import { HandoffPreview } from './HandoffPreview'

interface HandoffEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task
  activeParking?: ContextParking | null
  availableDecisions: Decision[]
  availableBlockers: TaskBlocker[]
  onSubmit: (input: HandoffDocumentInput) => Promise<void>
  defaultRecipient?: string
}

/**
 * Section header with icon
 */
function SectionHeader({
  icon: Icon,
  title,
  description,
  color,
}: {
  icon: typeof Terminal
  title: string
  description?: string
  color: string
}) {
  return (
    <div className={cn('flex items-start gap-3 mb-3', color)}>
      <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" />
      <div>
        <h4 className="font-mono font-semibold text-sm uppercase tracking-wider">{title}</h4>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
    </div>
  )
}

/**
 * HandoffEditor - Edit/customize handoff sections
 *
 * Provides forms to:
 * - Set recipient name
 * - Edit summary (auto-compiled from task)
 * - Edit context notes (auto-compiled from parking)
 * - Select decisions to include
 * - Select blockers to include
 * - Edit next steps (editable list)
 * - Edit gotchas (editable notes)
 * - Edit contact info
 */
export function HandoffEditor({
  open,
  onOpenChange,
  task,
  activeParking,
  availableDecisions,
  availableBlockers,
  onSubmit,
  defaultRecipient = '',
}: HandoffEditorProps) {
  // Form state
  const [recipient, setRecipient] = useState(defaultRecipient)
  const [summary, setSummary] = useState('')
  const [contextNotes, setContextNotes] = useState('')
  const [selectedDecisionIds, setSelectedDecisionIds] = useState<Set<string>>(new Set())
  const [selectedBlockerIds, setSelectedBlockerIds] = useState<Set<string>>(new Set())
  const [nextSteps, setNextSteps] = useState<string[]>([])
  const [newStep, setNewStep] = useState('')
  const [gotchas, setGotchas] = useState('')
  const [contact, setContact] = useState('')

  // UI state
  const [showPreview, setShowPreview] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Initialize form with task data
  useEffect(() => {
    if (open) {
      // Auto-compile summary from task
      setSummary(task.title)

      // Auto-compile context from parking lot
      let context = task.description || ''
      if (activeParking) {
        context += `\n\n--- Last Parked Context ---\n${activeParking.content}`
        if (activeParking.nextSteps) {
          context += `\n\nParked Next Steps:\n${activeParking.nextSteps}`
        }
        if (activeParking.discoveryNotes) {
          context += `\n\nDiscoveries:\n${activeParking.discoveryNotes}`
        }
      }
      setContextNotes(context.trim())

      // Pre-select related decisions
      const taskDecisions = availableDecisions.filter((d) =>
        d.relatedTaskIds.includes(task.id)
      )
      setSelectedDecisionIds(new Set(taskDecisions.map((d) => d.id)))

      // Pre-select active blockers
      const activeBlockers = availableBlockers.filter(
        (b) => b.taskId === task.id && !b.unblockedAt
      )
      setSelectedBlockerIds(new Set(activeBlockers.map((b) => b.id)))

      // Initialize next steps from parking
      if (activeParking?.nextSteps) {
        const steps = activeParking.nextSteps
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        setNextSteps(steps)
      } else {
        setNextSteps([])
      }

      setGotchas('')
      setContact('')
    }
  }, [open, task, activeParking, availableDecisions, availableBlockers])

  function handleAddStep() {
    if (newStep.trim()) {
      setNextSteps((prev) => [...prev, newStep.trim()])
      setNewStep('')
    }
  }

  function handleRemoveStep(index: number) {
    setNextSteps((prev) => prev.filter((_, i) => i !== index))
  }

  function handleMoveStep(index: number, direction: 'up' | 'down') {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= nextSteps.length) return

    setNextSteps((prev) => {
      const copy = [...prev]
      const temp = copy[index]
      copy[index] = copy[newIndex]
      copy[newIndex] = temp
      return copy
    })
  }

  function toggleDecision(id: string) {
    setSelectedDecisionIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleBlocker(id: string) {
    setSelectedBlockerIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function handlePreview() {
    if (!recipient.trim()) {
      // Could show error, for now just return
      return
    }
    setShowPreview(true)
  }

  async function handleSubmit() {
    if (!recipient.trim()) return

    setIsSubmitting(true)
    try {
      const input: HandoffDocumentInput = {
        taskId: task.id,
        handedOffTo: recipient.trim(),
        summary: summary.trim(),
        contextNotes: contextNotes.trim(),
        decisions: Array.from(selectedDecisionIds),
        blockers: Array.from(selectedBlockerIds),
        nextSteps: nextSteps.filter((s) => s.trim()),
        gotchas: gotchas.trim() || undefined,
        contact: contact.trim(),
      }

      await onSubmit(input)
      setShowPreview(false)
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedDecisions = availableDecisions.filter((d) => selectedDecisionIds.has(d.id))
  const selectedBlockers = availableBlockers.filter((b) => selectedBlockerIds.has(b.id))

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-xl overflow-y-auto bg-[#0a0a14]/95 border-cyan-500/30"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-cyan-400 font-mono">
              <FileText className="h-5 w-5" />
              Create Handoff Document
            </SheetTitle>
            <SheetDescription>
              Hand off <span className="text-cyan-400 font-semibold">{task.title}</span> to a teammate
            </SheetDescription>
          </SheetHeader>

          <div className="py-6 space-y-6">
            {/* Recipient */}
            <div className="space-y-2">
              <SectionHeader icon={User} title="Hand off to" color="text-emerald-400" />
              <Input
                value={recipient}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRecipient(e.target.value)}
                placeholder="Enter recipient name or @username"
                className="bg-black/30 border-emerald-500/30 focus:border-emerald-500"
              />
            </div>

            {/* Summary */}
            <div className="space-y-2">
              <SectionHeader
                icon={Terminal}
                title="Summary"
                description="Brief title for this handoff"
                color="text-cyan-400"
              />
              <Input
                value={summary}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSummary(e.target.value)}
                placeholder="Task summary"
                className="bg-black/30 border-cyan-500/30 focus:border-cyan-500"
              />
            </div>

            {/* Context Notes */}
            <div className="space-y-2">
              <SectionHeader
                icon={Terminal}
                title="Context Notes"
                description="Background information and current state"
                color="text-cyan-400"
              />
              <Textarea
                value={contextNotes}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContextNotes(e.target.value)}
                placeholder="Add context about where you left off..."
                className="min-h-[150px] bg-black/30 border-cyan-500/30 focus:border-cyan-500 font-mono text-sm"
              />
            </div>

            {/* Decisions */}
            {availableDecisions.length > 0 && (
              <div className="space-y-2">
                <SectionHeader
                  icon={Scale}
                  title={`Decisions (${selectedDecisionIds.size}/${availableDecisions.length})`}
                  description="Include relevant decisions"
                  color="text-purple-400"
                />
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {availableDecisions.map((decision) => (
                    <label
                      key={decision.id}
                      className={cn(
                        'flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors',
                        'border',
                        selectedDecisionIds.has(decision.id)
                          ? 'bg-purple-500/10 border-purple-500/30'
                          : 'bg-black/20 border-transparent hover:border-purple-500/20'
                      )}
                    >
                      <Checkbox
                        checked={selectedDecisionIds.has(decision.id)}
                        onCheckedChange={() => toggleDecision(decision.id)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-purple-300">{decision.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {decision.impactArea} - {decision.decidedBy}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Blockers */}
            {availableBlockers.length > 0 && (
              <div className="space-y-2">
                <SectionHeader
                  icon={Ban}
                  title={`Blockers (${selectedBlockerIds.size}/${availableBlockers.length})`}
                  description="Include active blockers"
                  color="text-rose-400"
                />
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {availableBlockers.map((blocker) => (
                    <label
                      key={blocker.id}
                      className={cn(
                        'flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors',
                        'border',
                        selectedBlockerIds.has(blocker.id)
                          ? 'bg-rose-500/10 border-rose-500/30'
                          : 'bg-black/20 border-transparent hover:border-rose-500/20'
                      )}
                    >
                      <Checkbox
                        checked={selectedBlockerIds.has(blocker.id)}
                        onCheckedChange={() => toggleBlocker(blocker.id)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-rose-300">{blocker.reason}</p>
                        {blocker.blockerOwner && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Owner: {blocker.blockerOwner}
                          </p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Next Steps */}
            <div className="space-y-2">
              <SectionHeader
                icon={ListChecks}
                title={`Next Steps (${nextSteps.length})`}
                description="Action items for the recipient"
                color="text-emerald-400"
              />
              <div className="space-y-2">
                {nextSteps.map((step, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
                  >
                    <div className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={() => handleMoveStep(index, 'up')}
                        disabled={index === 0}
                        className="p-0.5 text-emerald-400/50 hover:text-emerald-400 disabled:opacity-30"
                      >
                        <GripVertical className="h-3 w-3 rotate-180" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveStep(index, 'down')}
                        disabled={index === nextSteps.length - 1}
                        className="p-0.5 text-emerald-400/50 hover:text-emerald-400 disabled:opacity-30"
                      >
                        <GripVertical className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="h-4 w-4 rounded border-2 border-emerald-500/50 flex-shrink-0" />
                    <span className="flex-1 text-sm font-mono text-foreground/90">{step}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveStep(index)}
                      className="p-1 text-rose-400/50 hover:text-rose-400"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newStep}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewStep(e.target.value)}
                  placeholder="Add a next step..."
                  className="bg-black/30 border-emerald-500/30 focus:border-emerald-500"
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddStep()
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleAddStep}
                  className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Gotchas */}
            <div className="space-y-2">
              <SectionHeader
                icon={AlertTriangle}
                title="Gotchas / Watch Out For"
                description="Potential pitfalls or important warnings"
                color="text-amber-400"
              />
              <Textarea
                value={gotchas}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setGotchas(e.target.value)}
                placeholder="Any gotchas the recipient should know about..."
                className="min-h-[80px] bg-black/30 border-amber-500/30 focus:border-amber-500 font-mono text-sm"
              />
            </div>

            {/* Contact */}
            <div className="space-y-2">
              <SectionHeader
                icon={Phone}
                title="Contact Info"
                description="How to reach you for questions"
                color="text-cyan-400"
              />
              <Textarea
                value={contact}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContact(e.target.value)}
                placeholder="Slack: @username&#10;Email: you@example.com&#10;Available: Mon-Fri 9-5"
                className="min-h-[80px] bg-black/30 border-cyan-500/30 focus:border-cyan-500 font-mono text-sm"
              />
            </div>
          </div>

          <SheetFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-muted-foreground/30"
            >
              Cancel
            </Button>
            <Button
              onClick={handlePreview}
              disabled={!recipient.trim()}
              className="gap-2 bg-cyan-600 hover:bg-cyan-700 text-white"
            >
              <Eye className="h-4 w-4" />
              Preview & Send
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Preview modal */}
      <HandoffPreview
        open={showPreview}
        onOpenChange={setShowPreview}
        task={task}
        recipient={recipient}
        contextNotes={contextNotes}
        decisions={selectedDecisions}
        blockers={selectedBlockers}
        nextSteps={nextSteps}
        gotchas={gotchas}
        contact={contact}
        onConfirm={handleSubmit}
        onEdit={() => setShowPreview(false)}
        isSubmitting={isSubmitting}
      />
    </>
  )
}
