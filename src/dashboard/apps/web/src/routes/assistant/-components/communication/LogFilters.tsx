import {
  MessageSquare,
  Github,
  Mail,
  Users,
  Pencil,
  CheckCircle,
  AlertTriangle,
  MessageCircle,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { CommunicationSource, CommunicationSentiment } from '@/lib/assistant/types'

export type FilterTab = 'all' | CommunicationSentiment

interface LogFiltersProps {
  // Tab filter
  activeTab: FilterTab
  onTabChange: (tab: FilterTab) => void
  tabCounts: Record<FilterTab, number>

  // Source filter
  activeSource: CommunicationSource | 'all'
  onSourceChange: (source: CommunicationSource | 'all') => void
  sourceCounts: Record<CommunicationSource | 'all', number>

  className?: string
}

/**
 * Get source icon
 */
function getSourceIcon(source: CommunicationSource | 'all') {
  switch (source) {
    case 'slack':
      return MessageSquare
    case 'github':
      return Github
    case 'email':
      return Mail
    case 'meeting':
      return Users
    case 'manual':
      return Pencil
    default:
      return MessageCircle
  }
}

/**
 * Get source color
 */
function getSourceColor(source: CommunicationSource | 'all', active: boolean) {
  if (!active) return 'text-muted-foreground'
  switch (source) {
    case 'slack':
      return 'text-purple-400'
    case 'github':
      return 'text-gray-400'
    case 'email':
      return 'text-blue-400'
    case 'meeting':
      return 'text-emerald-400'
    case 'manual':
      return 'text-amber-400'
    default:
      return 'text-foreground'
  }
}

/**
 * LogFilters component - Filter tabs and source filters for communication log
 */
export function LogFilters({
  activeTab,
  onTabChange,
  tabCounts,
  activeSource,
  onSourceChange,
  sourceCounts,
  className,
}: LogFiltersProps) {
  const tabs: { id: FilterTab; label: string; icon: typeof CheckCircle; color: string }[] = [
    { id: 'all', label: 'All', icon: MessageCircle, color: 'text-foreground' },
    { id: 'decision', label: 'Decisions', icon: CheckCircle, color: 'text-purple-400' },
    { id: 'blocker', label: 'Blockers', icon: AlertTriangle, color: 'text-red-400' },
    { id: 'context', label: 'Context', icon: Info, color: 'text-gray-400' },
  ]

  const sources: { id: CommunicationSource | 'all'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'slack', label: 'Slack' },
    { id: 'github', label: 'GitHub' },
    { id: 'email', label: 'Email' },
    { id: 'meeting', label: 'Meeting' },
    { id: 'manual', label: 'Manual' },
  ]

  return (
    <div className={cn('space-y-4', className)}>
      {/* Tab filters */}
      <div className="flex items-center gap-1 p-1 bg-white/5 rounded-lg border border-white/10">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id
          const Icon = tab.icon
          const count = tabCounts[tab.id]

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                isActive
                  ? 'bg-white/10 shadow-sm'
                  : 'hover:bg-white/5 text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className={cn('h-4 w-4', isActive ? tab.color : 'text-muted-foreground')} />
              <span className={isActive ? tab.color : undefined}>{tab.label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    'min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold flex items-center justify-center',
                    isActive
                      ? 'bg-white/10 text-foreground'
                      : 'bg-white/5 text-muted-foreground'
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Source filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium mr-1">Source:</span>
        {sources.map((source) => {
          const isActive = activeSource === source.id
          const Icon = getSourceIcon(source.id)
          const count = sourceCounts[source.id]

          return (
            <Button
              key={source.id}
              variant="ghost"
              size="sm"
              onClick={() => onSourceChange(source.id)}
              className={cn(
                'h-7 px-2 gap-1.5 text-xs',
                isActive
                  ? 'bg-white/10 hover:bg-white/15'
                  : 'hover:bg-white/5 text-muted-foreground'
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', getSourceColor(source.id, isActive))} />
              <span className={isActive ? getSourceColor(source.id, isActive) : undefined}>
                {source.label}
              </span>
              {count > 0 && source.id !== 'all' && (
                <span className="text-[10px] text-muted-foreground">({count})</span>
              )}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
