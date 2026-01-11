import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  Loader2,
  Calendar,
  Clock,
  AlertTriangle,
  AlertCircle,
  Sparkles,
  CheckCircle,
  Play,
  Ban,
  Circle,
  Trash2,
  Save,
  ParkingCircle,
  ExternalLink,
  Github,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { DashboardLayout } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import { useTaskStore } from '../-hooks'
import type { Task, TaskUpdate, UrgencyLevel, TaskStatus, ContextParking } from '../-types'
import { getUrgencyColor } from '../-types'

export const Route = createFileRoute('/assistant/tasks/$taskId')({
  component: TaskDetailPage,
})

function TaskDetailPage() {
  const { taskId } = Route.useParams()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null

  const {
    tasks,
    loading,
    initialized,
    updateTask,
    deleteTask,
    completeTask,
    getActiveParking,
    getParkingHistory,
  } = useTaskStore(userId)

  const task = tasks.find((t) => t.id === taskId)

  // Form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [urgency, setUrgency] = useState<UrgencyLevel>('nice-to-have')
  const [deadline, setDeadline] = useState('')
  const [linkedGitHub, setLinkedGitHub] = useState('')
  const [status, setStatus] = useState<TaskStatus>('backlog')
  const [isShippingBlocker, setIsShippingBlocker] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  // Context parking state
  const [activeParking, setActiveParking] = useState<ContextParking | null>(null)
  const [parkingHistory, setParkingHistory] = useState<ContextParking[]>([])

  // Initialize form with task data
  useEffect(() => {
    if (task) {
      setTitle(task.title)
      setDescription(task.description)
      setUrgency(task.urgencyLevel)
      setDeadline(task.deadline ? formatDateForInput(new Date(task.deadline)) : '')
      setLinkedGitHub(task.linkedGitHub ?? '')
      setStatus(task.status)
      setIsShippingBlocker(task.isShippingBlocker)
      setHasChanges(false)
    }
  }, [task])

  // Load parking context - only run when taskId changes
  useEffect(() => {
    let mounted = true

    async function loadParking() {
      if (taskId && initialized) {
        const active = await getActiveParking(taskId)
        if (mounted) setActiveParking(active)

        const history = await getParkingHistory(taskId)
        if (mounted) setParkingHistory(history.slice(0, 5)) // Last 5 entries
      }
    }
    loadParking()

    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, initialized])

  function formatDateForInput(date: Date): string {
    return date.toISOString().split('T')[0]
  }

  function formatDateTime(date: Date): string {
    return new Date(date).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  function markChanged() {
    setHasChanges(true)
  }

  async function handleSave() {
    if (!task) return

    setIsSaving(true)
    try {
      const updates: TaskUpdate = {
        title: title.trim(),
        description: description.trim(),
        urgencyLevel: urgency,
        deadline: deadline ? new Date(deadline) : undefined,
        linkedGitHub: linkedGitHub.trim() || undefined,
        status,
        isShippingBlocker,
      }

      await updateTask(task.id, updates)
      setHasChanges(false)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleComplete() {
    if (!task) return
    await completeTask(task.id)
    navigate({ to: '/assistant/tasks' })
  }

  async function handleDelete() {
    if (!task) return
    if (confirm('Are you sure you want to delete this task?')) {
      await deleteTask(task.id)
      navigate({ to: '/assistant/tasks' })
    }
  }

  async function handleStartWork() {
    if (!task) return
    await updateTask(task.id, { status: 'in-progress' })
    setStatus('in-progress')
  }

  // Loading state
  if (authLoading || (!initialized && loading)) {
    return (
      <DashboardLayout title="Task" description="Loading...">
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
            <span className="text-muted-foreground text-sm font-mono">Loading task...</span>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  // Not found
  if (!task) {
    return (
      <DashboardLayout title="Task Not Found" description="The task you're looking for doesn't exist">
        <div className="flex flex-col items-center justify-center py-24">
          <p className="text-muted-foreground mb-4">This task doesn't exist or was deleted.</p>
          <Button asChild variant="outline">
            <Link to="/assistant/tasks">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Tasks
            </Link>
          </Button>
        </div>
      </DashboardLayout>
    )
  }

  const urgencyColors = getUrgencyColor(urgency)
  const isCompleted = status === 'completed'

  return (
    <DashboardLayout title="Edit Task" description={task.title}>
      {/* Header with back button */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="sm">
            <Link to="/assistant/tasks">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>

          {/* Status indicator */}
          <StatusBadge status={status} />
        </div>

        <div className="flex items-center gap-2">
          {/* Delete button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="h-4 w-4" />
          </Button>

          {/* Complete button */}
          {!isCompleted && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleComplete}
              className="gap-2"
            >
              <CheckCircle className="h-4 w-4 text-green-400" />
              Complete
            </Button>
          )}

          {/* Save button */}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="gap-2 bg-purple-600 hover:bg-purple-700"
          >
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content - 2 columns */}
        <div className="lg:col-span-2 space-y-6">
          {/* Title and description */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title" className="text-sm font-medium">
                    Task Title
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setTitle(e.target.value)
                      markChanged()
                    }}
                    placeholder="Task title"
                    className="bg-background/50 text-lg font-semibold"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description" className="text-sm font-medium">
                    Description
                  </Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                      setDescription(e.target.value)
                      markChanged()
                    }}
                    placeholder="Add more details..."
                    className="bg-background/50 min-h-[120px] resize-none"
                  />
                </div>
              </div>
            </FeatureCardHeader>
          </FeatureCard>

          {/* Urgency selector */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <Label className="text-sm font-medium mb-3 block">Urgency Level</Label>
              <div className="flex gap-2">
                <UrgencyButton
                  urgency="critical"
                  selected={urgency === 'critical'}
                  onClick={() => {
                    setUrgency('critical')
                    markChanged()
                  }}
                />
                <UrgencyButton
                  urgency="important"
                  selected={urgency === 'important'}
                  onClick={() => {
                    setUrgency('important')
                    markChanged()
                  }}
                />
                <UrgencyButton
                  urgency="nice-to-have"
                  selected={urgency === 'nice-to-have'}
                  onClick={() => {
                    setUrgency('nice-to-have')
                    markChanged()
                  }}
                />
              </div>

              {/* Shipping blocker toggle */}
              {urgency === 'critical' && (
                <div className="flex items-center gap-3 mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                  <input
                    type="checkbox"
                    id="shipping-blocker"
                    checked={isShippingBlocker}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setIsShippingBlocker(e.target.checked)
                      markChanged()
                    }}
                    className="h-4 w-4 rounded border-red-500/50 bg-transparent text-red-500 focus:ring-red-500/50"
                  />
                  <Label
                    htmlFor="shipping-blocker"
                    className="text-sm text-red-300 cursor-pointer"
                  >
                    This blocks shipping / deployment
                  </Label>
                </div>
              )}
            </FeatureCardHeader>
          </FeatureCard>

          {/* Context Parking Lot */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <ParkingCircle className="h-5 w-5 text-purple-400" />
                  <Label className="text-sm font-medium">Context Parking Lot</Label>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  className="text-purple-400 hover:text-purple-300"
                >
                  <Link to="/assistant/parking">View All</Link>
                </Button>
              </div>

              {activeParking ? (
                <div className="p-4 rounded-lg bg-purple-500/10 border border-purple-500/20">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-purple-300 font-medium">
                      Last parked {formatDateTime(new Date(activeParking.parkedAt))}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-purple-400 font-semibold px-2 py-0.5 rounded bg-purple-500/20">
                      Active
                    </span>
                  </div>
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap">
                    {activeParking.content}
                  </p>
                  {activeParking.nextSteps && (
                    <div className="mt-3 pt-3 border-t border-purple-500/20">
                      <span className="text-xs text-purple-300 font-medium">Next steps:</span>
                      <p className="text-sm text-foreground/80 mt-1">{activeParking.nextSteps}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-6 text-center rounded-lg border border-dashed border-purple-500/30">
                  <ParkingCircle className="h-8 w-8 text-purple-400/50 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No context parked for this task.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Press <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs">Cmd+P</kbd> to
                    park your context before switching.
                  </p>
                </div>
              )}

              {/* Recent parking history */}
              {parkingHistory.length > 1 && (
                <div className="mt-4 space-y-2">
                  <span className="text-xs text-muted-foreground font-medium">Recent history</span>
                  {parkingHistory.slice(1, 4).map((parking) => (
                    <div
                      key={parking.id}
                      className="p-3 rounded-lg bg-muted/30 border border-border/50"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground">
                          {formatDateTime(new Date(parking.parkedAt))}
                        </span>
                        <span
                          className={cn(
                            'text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded',
                            parking.status === 'resumed'
                              ? 'text-green-400 bg-green-500/20'
                              : 'text-gray-400 bg-gray-500/20'
                          )}
                        >
                          {parking.status}
                        </span>
                      </div>
                      <p className="text-xs text-foreground/70 line-clamp-2">{parking.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </FeatureCardHeader>
          </FeatureCard>
        </div>

        {/* Sidebar - 1 column */}
        <div className="space-y-6">
          {/* Quick actions */}
          {!isCompleted && status === 'backlog' && (
            <Button
              onClick={handleStartWork}
              className="w-full gap-2 bg-blue-600 hover:bg-blue-700"
            >
              <Play className="h-4 w-4" />
              Start Working
            </Button>
          )}

          {/* Deadline */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <div className="flex items-center gap-2 mb-3">
                <Calendar className="h-4 w-4 text-purple-400" />
                <Label className="text-sm font-medium">Deadline</Label>
              </div>
              <Input
                type="date"
                value={deadline}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setDeadline(e.target.value)
                  markChanged()
                }}
                className="bg-background/50"
              />
              {deadline && (
                <DeadlineDisplay deadline={new Date(deadline)} />
              )}
            </FeatureCardHeader>
          </FeatureCard>

          {/* Status */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <Label className="text-sm font-medium mb-3 block">Status</Label>
              <div className="grid grid-cols-2 gap-2">
                {(['backlog', 'in-progress', 'blocked', 'completed'] as TaskStatus[]).map((s) => (
                  <StatusButton
                    key={s}
                    status={s}
                    selected={status === s}
                    onClick={() => {
                      setStatus(s)
                      markChanged()
                    }}
                  />
                ))}
              </div>
            </FeatureCardHeader>
          </FeatureCard>

          {/* GitHub link */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <div className="flex items-center gap-2 mb-3">
                <Github className="h-4 w-4 text-purple-400" />
                <Label className="text-sm font-medium">GitHub Link</Label>
              </div>
              <Input
                value={linkedGitHub}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setLinkedGitHub(e.target.value)
                  markChanged()
                }}
                placeholder="https://github.com/..."
                className="bg-background/50"
              />
              {linkedGitHub && (
                <a
                  href={linkedGitHub}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 mt-2"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in GitHub
                </a>
              )}
            </FeatureCardHeader>
          </FeatureCard>

          {/* Task metadata */}
          <FeatureCard color="purple">
            <FeatureCardHeader>
              <Label className="text-sm font-medium mb-3 block">Details</Label>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Focus time</span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    {formatFocusTime(task.focusTimeLogged)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Created</span>
                  <span>{formatDateTime(new Date(task.createdAt))}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Updated</span>
                  <span>{formatDateTime(new Date(task.updatedAt))}</span>
                </div>
                {task.completedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Completed</span>
                    <span className="text-green-400">
                      {formatDateTime(new Date(task.completedAt))}
                    </span>
                  </div>
                )}
              </div>
            </FeatureCardHeader>
          </FeatureCard>
        </div>
      </div>
    </DashboardLayout>
  )
}

// Helper components

function UrgencyButton({
  urgency,
  selected,
  onClick,
}: {
  urgency: UrgencyLevel
  selected: boolean
  onClick: () => void
}) {
  const config = {
    critical: {
      label: 'Critical',
      icon: AlertTriangle,
      color: 'text-red-400',
      bg: 'bg-red-500/10',
      border: 'border-red-500/30',
      activeBorder: 'border-red-500',
    },
    important: {
      label: 'Important',
      icon: AlertCircle,
      color: 'text-orange-400',
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/30',
      activeBorder: 'border-orange-500',
    },
    'nice-to-have': {
      label: 'Nice to Have',
      icon: Sparkles,
      color: 'text-yellow-400',
      bg: 'bg-yellow-500/10',
      border: 'border-yellow-500/30',
      activeBorder: 'border-yellow-500',
    },
  }

  const c = config[urgency]
  const Icon = c.icon

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 p-3 rounded-lg border-2 transition-all',
        c.bg,
        selected ? c.activeBorder : c.border
      )}
    >
      <div className="flex items-center justify-center gap-2">
        <Icon className={cn('h-4 w-4', c.color)} />
        <span className={cn('font-semibold text-sm', c.color)}>{c.label}</span>
      </div>
    </button>
  )
}

function StatusButton({
  status,
  selected,
  onClick,
}: {
  status: TaskStatus
  selected: boolean
  onClick: () => void
}) {
  const config = {
    backlog: { label: 'Backlog', icon: Circle, color: 'text-gray-400', bg: 'bg-gray-500/10' },
    'in-progress': { label: 'In Progress', icon: Play, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    blocked: { label: 'Blocked', icon: Ban, color: 'text-red-400', bg: 'bg-red-500/10' },
    completed: { label: 'Done', icon: CheckCircle, color: 'text-green-400', bg: 'bg-green-500/10' },
  }

  const c = config[status]
  const Icon = c.icon

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'p-2 rounded-lg border transition-all text-center',
        c.bg,
        selected ? 'border-current ring-2 ring-offset-2 ring-offset-background' : 'border-transparent',
        c.color
      )}
    >
      <Icon className="h-4 w-4 mx-auto mb-1" />
      <span className="text-xs font-medium">{c.label}</span>
    </button>
  )
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const config = {
    backlog: { label: 'Backlog', icon: Circle, color: 'text-gray-400 bg-gray-500/20' },
    'in-progress': { label: 'In Progress', icon: Play, color: 'text-blue-400 bg-blue-500/20' },
    blocked: { label: 'Blocked', icon: Ban, color: 'text-red-400 bg-red-500/20' },
    completed: { label: 'Completed', icon: CheckCircle, color: 'text-green-400 bg-green-500/20' },
  }

  const c = config[status]
  const Icon = c.icon

  return (
    <span className={cn('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', c.color)}>
      <Icon className="h-3.5 w-3.5" />
      {c.label}
    </span>
  )
}

function DeadlineDisplay({ deadline }: { deadline: Date }) {
  const now = new Date()
  const diff = deadline.getTime() - now.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  let message: string
  let colorClass: string

  if (diff < 0) {
    const absDays = Math.abs(days)
    message = absDays === 0 ? 'Overdue!' : `${absDays} day${absDays !== 1 ? 's' : ''} overdue`
    colorClass = 'text-red-400'
  } else if (days === 0) {
    message = 'Due today!'
    colorClass = 'text-orange-400'
  } else if (days === 1) {
    message = 'Due tomorrow'
    colorClass = 'text-orange-400'
  } else if (days <= 7) {
    message = `${days} days left`
    colorClass = 'text-yellow-400'
  } else {
    message = `${days} days left`
    colorClass = 'text-green-400'
  }

  return (
    <p className={cn('text-xs mt-2 font-medium', colorClass)}>{message}</p>
  )
}

function formatFocusTime(minutes: number): string {
  if (minutes === 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60

  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}
