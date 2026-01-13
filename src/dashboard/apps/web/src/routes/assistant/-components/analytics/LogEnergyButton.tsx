import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Zap, Plus, Brain, MessageSquare, FileText, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { FocusQuality, WorkType, EnergySnapshotInput } from '@/lib/assistant/types'

interface LogEnergyButtonProps {
  onLogEnergy: (input: EnergySnapshotInput) => Promise<void>
  loading?: boolean
  className?: string
}

/**
 * Focus quality options with descriptions
 */
const FOCUS_QUALITY_OPTIONS: Array<{
  value: FocusQuality
  label: string
  description: string
  color: string
}> = [
  { value: 1, label: '1', description: 'Very Poor', color: 'bg-red-900/60 border-red-500/40 hover:border-red-400' },
  { value: 2, label: '2', description: 'Poor', color: 'bg-red-800/40 border-red-500/30 hover:border-red-400' },
  { value: 3, label: '3', description: 'Average', color: 'bg-amber-700/40 border-amber-500/30 hover:border-amber-400' },
  { value: 4, label: '4', description: 'Good', color: 'bg-cyan-600/40 border-cyan-500/30 hover:border-cyan-400' },
  { value: 5, label: '5', description: 'Excellent', color: 'bg-cyan-400/50 border-cyan-400/40 hover:border-cyan-300' },
]

/**
 * Work type options
 */
const WORK_TYPE_OPTIONS: Array<{
  value: WorkType
  label: string
  icon: React.ElementType
  color: string
}> = [
  { value: 'deep-work', label: 'Deep Work', icon: Brain, color: 'text-purple-400' },
  { value: 'communication', label: 'Communication', icon: MessageSquare, color: 'text-blue-400' },
  { value: 'admin', label: 'Admin', icon: FileText, color: 'text-slate-400' },
  { value: 'meeting', label: 'Meeting', icon: Users, color: 'text-orange-400' },
]

/**
 * LogEnergyButton - Quick self-report button with modal
 *
 * Allows users to log their current energy and focus state
 * with minimal friction.
 */
export function LogEnergyButton({
  onLogEnergy,
  loading = false,
  className,
}: LogEnergyButtonProps) {
  const [open, setOpen] = useState(false)
  const [focusQuality, setFocusQuality] = useState<FocusQuality>(3)
  const [typeOfWork, setTypeOfWork] = useState<WorkType>('deep-work')
  const [contextSwitches, setContextSwitches] = useState(0)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    setSubmitting(true)
    try {
      await onLogEnergy({
        focusQuality,
        typeOfWork,
        contextSwitches,
        notes: notes.trim() || undefined,
        tasksCompleted: 0,
      })
      // Reset form and close
      setFocusQuality(3)
      setTypeOfWork('deep-work')
      setContextSwitches(0)
      setNotes('')
      setOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={loading}
        className={cn(
          'gap-2 border-cyan-500/30 hover:border-cyan-500/50 hover:bg-cyan-500/10',
          className
        )}
      >
        <Plus className="h-4 w-4" />
        <span>Log Energy</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-slate-950/95 border-cyan-500/30 max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-100">
              <Zap className="h-5 w-5 text-cyan-400" />
              Log Energy Snapshot
            </DialogTitle>
            <DialogDescription>
              Record your current focus level and work type.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Focus Quality */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">
                Focus Quality
              </label>
              <div className="flex gap-2">
                {FOCUS_QUALITY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setFocusQuality(option.value)}
                    className={cn(
                      'flex-1 py-3 rounded-lg border-2 transition-all',
                      'flex flex-col items-center gap-1',
                      option.color,
                      focusQuality === option.value
                        ? 'ring-2 ring-cyan-400 ring-offset-2 ring-offset-slate-950'
                        : 'opacity-60'
                    )}
                  >
                    <span className="text-lg font-bold text-slate-100">{option.label}</span>
                    <span className="text-[10px] text-slate-400 hidden sm:block">{option.description}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-500 text-center">
                Selected: <span className="text-slate-300">{FOCUS_QUALITY_OPTIONS.find(o => o.value === focusQuality)?.description}</span>
              </p>
            </div>

            {/* Work Type */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">
                Type of Work
              </label>
              <div className="grid grid-cols-2 gap-2">
                {WORK_TYPE_OPTIONS.map((option) => {
                  const Icon = option.icon
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setTypeOfWork(option.value)}
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 rounded-lg border transition-all',
                        'bg-slate-900/50',
                        typeOfWork === option.value
                          ? 'border-cyan-500/50 bg-cyan-500/10'
                          : 'border-slate-700/50 hover:border-slate-600/50'
                      )}
                    >
                      <Icon className={cn('h-4 w-4', option.color)} />
                      <span className="text-sm text-slate-300">{option.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Context Switches */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">
                Context Switches (interruptions)
              </label>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setContextSwitches(Math.max(0, contextSwitches - 1))}
                  className="border-slate-700"
                >
                  -
                </Button>
                <span className="w-12 text-center text-xl font-bold text-cyan-400">
                  {contextSwitches}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={() => setContextSwitches(contextSwitches + 1)}
                  className="border-slate-700"
                >
                  +
                </Button>
              </div>
            </div>

            {/* Notes (optional) */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-300">
                Notes <span className="text-slate-500">(optional)</span>
              </label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What affected your focus?"
                className="bg-slate-900/50 border-slate-700/50 resize-none h-20"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="bg-cyan-600 hover:bg-cyan-500 text-white"
            >
              {submitting ? 'Saving...' : 'Save Snapshot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Floating action button version
 */
export function LogEnergyFAB({
  onLogEnergy,
  loading = false,
  className,
}: LogEnergyButtonProps) {
  const [open, setOpen] = useState(false)
  const [focusQuality, setFocusQuality] = useState<FocusQuality>(3)
  const [typeOfWork, setTypeOfWork] = useState<WorkType>('deep-work')
  const [submitting, setSubmitting] = useState(false)

  async function handleQuickSubmit() {
    setSubmitting(true)
    try {
      await onLogEnergy({
        focusQuality,
        typeOfWork,
        contextSwitches: 0,
        tasksCompleted: 0,
      })
      setOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        variant="default"
        size="icon-lg"
        onClick={() => setOpen(true)}
        disabled={loading}
        className={cn(
          'fixed bottom-6 right-6 z-50',
          'rounded-full shadow-lg',
          'bg-cyan-600 hover:bg-cyan-500',
          'shadow-cyan-500/30',
          className
        )}
        style={{ boxShadow: '0 0 20px rgba(34, 211, 238, 0.3)' }}
      >
        <Zap className="h-5 w-5" />
        <span className="sr-only">Log Energy</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-slate-950/95 border-cyan-500/30 max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-100">
              <Zap className="h-5 w-5 text-cyan-400" />
              Quick Energy Log
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Focus Quality - simplified */}
            <div className="flex gap-1.5 justify-center">
              {FOCUS_QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFocusQuality(option.value)}
                  className={cn(
                    'w-10 h-10 rounded-lg border-2 transition-all',
                    'flex items-center justify-center',
                    option.color,
                    focusQuality === option.value
                      ? 'ring-2 ring-cyan-400 scale-110'
                      : 'opacity-50'
                  )}
                >
                  <span className="font-bold text-slate-100">{option.label}</span>
                </button>
              ))}
            </div>

            {/* Work Type - simplified */}
            <div className="flex gap-2 justify-center">
              {WORK_TYPE_OPTIONS.map((option) => {
                const Icon = option.icon
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setTypeOfWork(option.value)}
                    className={cn(
                      'p-2 rounded-lg border transition-all',
                      typeOfWork === option.value
                        ? 'border-cyan-500/50 bg-cyan-500/10'
                        : 'border-slate-700/30 opacity-50'
                    )}
                    title={option.label}
                  >
                    <Icon className={cn('h-5 w-5', option.color)} />
                  </button>
                )
              })}
            </div>
          </div>

          <DialogFooter>
            <Button
              onClick={handleQuickSubmit}
              disabled={submitting}
              className="w-full bg-cyan-600 hover:bg-cyan-500 text-white"
            >
              {submitting ? 'Saving...' : 'Log Now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
