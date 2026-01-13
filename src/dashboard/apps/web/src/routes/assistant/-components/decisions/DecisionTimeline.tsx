import { useState } from 'react'
import { Scale, ChevronDown, ChevronRight, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Decision, DecisionStatus, DecisionImpactArea } from '@/lib/assistant/types'

interface DecisionTimelineProps {
  decisions: Decision[]
  onSelectDecision?: (decision: Decision) => void
  className?: string
}

/**
 * Status colors for timeline nodes
 */
const statusColors: Record<DecisionStatus, {
  nodeClass: string
  lineClass: string
  glowClass: string
}> = {
  active: {
    nodeClass: 'bg-emerald-500 border-emerald-400',
    lineClass: 'bg-emerald-500/30',
    glowClass: 'shadow-emerald-500/50',
  },
  superseded: {
    nodeClass: 'bg-gray-500 border-gray-400',
    lineClass: 'bg-gray-500/30',
    glowClass: 'shadow-gray-500/30',
  },
  reversed: {
    nodeClass: 'bg-rose-500 border-rose-400',
    lineClass: 'bg-rose-500/30',
    glowClass: 'shadow-rose-500/50',
  },
}

/**
 * Impact area badge colors
 */
const impactColors: Record<DecisionImpactArea, string> = {
  frontend: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  backend: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  infrastructure: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  process: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  architecture: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  product: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
}

/**
 * Format date for timeline
 */
function formatTimelineDate(date: Date): { month: string; day: string; year: string } {
  const d = new Date(date)
  return {
    month: d.toLocaleDateString('en-US', { month: 'short' }),
    day: d.getDate().toString(),
    year: d.getFullYear().toString(),
  }
}

/**
 * Group decisions by month
 */
function groupByMonth(decisions: Decision[]): Map<string, Decision[]> {
  const groups = new Map<string, Decision[]>()

  for (const decision of decisions) {
    const date = new Date(decision.decidedAt)
    const key = `${date.getFullYear()}-${date.getMonth()}`
    const existing = groups.get(key) ?? []
    groups.set(key, [...existing, decision])
  }

  return groups
}

/**
 * Timeline node component
 */
function TimelineNode({
  decision,
  isLast,
  onClick,
}: {
  decision: Decision
  isLast: boolean
  onClick?: () => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const colors = statusColors[decision.status]
  const dateInfo = formatTimelineDate(decision.decidedAt)

  return (
    <div className="relative flex gap-4">
      {/* Timeline line */}
      <div className="relative flex flex-col items-center">
        {/* Node */}
        <div
          className={cn(
            'relative z-10 h-4 w-4 rounded-full border-2',
            colors.nodeClass
          )}
          style={{
            boxShadow: `0 0 8px ${colors.glowClass.includes('emerald') ? 'rgba(52, 211, 153, 0.5)' : colors.glowClass.includes('rose') ? 'rgba(244, 63, 94, 0.5)' : 'rgba(107, 114, 128, 0.3)'}`,
          }}
        />

        {/* Connecting line */}
        {!isLast && (
          <div
            className={cn(
              'w-0.5 flex-1 min-h-[60px]',
              colors.lineClass
            )}
            style={{
              background: `linear-gradient(to bottom, ${colors.glowClass.includes('emerald') ? 'rgba(52, 211, 153, 0.3)' : colors.glowClass.includes('rose') ? 'rgba(244, 63, 94, 0.3)' : 'rgba(107, 114, 128, 0.2)'}, transparent)`,
            }}
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-6">
        {/* Date badge */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted-foreground font-mono">
            {dateInfo.month} {dateInfo.day}, {dateInfo.year}
          </span>
          <span
            className={cn(
              'text-[10px] px-2 py-0.5 rounded-full border',
              impactColors[decision.impactArea]
            )}
          >
            {decision.impactArea}
          </span>
        </div>

        {/* Decision card */}
        <button
          type="button"
          onClick={() => {
            if (onClick) onClick()
            setIsExpanded(!isExpanded)
          }}
          className={cn(
            'w-full text-left p-3 rounded-lg',
            'bg-[#0a0a14]/60 backdrop-blur-sm border border-white/10',
            'hover:bg-[#0a0a14]/80 hover:border-white/20 transition-all'
          )}
        >
          <div className="flex items-start gap-2">
            <Scale
              className={cn(
                'h-4 w-4 mt-0.5 flex-shrink-0',
                decision.status === 'active' && 'text-emerald-400',
                decision.status === 'superseded' && 'text-gray-400',
                decision.status === 'reversed' && 'text-rose-400'
              )}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4
                  className={cn(
                    'text-sm font-semibold',
                    decision.status !== 'active' && 'line-through text-muted-foreground'
                  )}
                >
                  {decision.title}
                </h4>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}
              </div>

              {/* Expanded content */}
              <div
                className={cn(
                  'overflow-hidden transition-all duration-300',
                  isExpanded ? 'max-h-[200px] opacity-100 mt-3' : 'max-h-0 opacity-0'
                )}
              >
                <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">
                  {decision.reasoning}
                </p>

                {decision.status === 'reversed' && decision.reversalReason && (
                  <p className="text-xs text-rose-400/80 mt-2">
                    Reversed: {decision.reversalReason}
                  </p>
                )}

                {decision.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {decision.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

/**
 * Month header for grouped timeline
 */
function MonthHeader({ month, year }: { month: string; year: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <Calendar className="h-4 w-4 text-purple-400" />
      <span className="text-sm font-semibold text-purple-400">
        {month} {year}
      </span>
      <div className="flex-1 h-px bg-gradient-to-r from-purple-500/20 to-transparent" />
    </div>
  )
}

/**
 * DecisionTimeline component - Visual timeline of decisions
 *
 * Shows decisions chronologically with a neon-styled timeline connector.
 * Decisions are grouped by month for easier navigation.
 */
export function DecisionTimeline({
  decisions,
  onSelectDecision,
  className,
}: DecisionTimelineProps) {
  if (decisions.length === 0) {
    return null
  }

  // Sort by date descending (most recent first)
  const sortedDecisions = [...decisions].sort(
    (a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime()
  )

  // Group by month
  const groupedDecisions = groupByMonth(sortedDecisions)

  return (
    <div className={cn('space-y-6', className)}>
      {Array.from(groupedDecisions.entries()).map(([key, monthDecisions]) => {
        const firstDate = new Date(monthDecisions[0].decidedAt)
        const month = firstDate.toLocaleDateString('en-US', { month: 'long' })
        const year = firstDate.getFullYear().toString()

        return (
          <div key={key}>
            <MonthHeader month={month} year={year} />

            <div className="pl-2">
              {monthDecisions.map((decision, index) => (
                <TimelineNode
                  key={decision.id}
                  decision={decision}
                  isLast={index === monthDecisions.length - 1}
                  onClick={onSelectDecision ? () => onSelectDecision(decision) : undefined}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Compact timeline for sidebars or small spaces
 */
export function CompactTimeline({
  decisions,
  onSelectDecision,
  maxItems = 5,
  className,
}: {
  decisions: Decision[]
  onSelectDecision?: (decision: Decision) => void
  maxItems?: number
  className?: string
}) {
  // Sort and limit
  const sortedDecisions = [...decisions]
    .sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime())
    .slice(0, maxItems)

  if (sortedDecisions.length === 0) {
    return null
  }

  return (
    <div className={cn('space-y-2', className)}>
      {sortedDecisions.map((decision, index) => {
        const colors = statusColors[decision.status]
        const date = new Date(decision.decidedAt)

        return (
          <button
            key={decision.id}
            type="button"
            onClick={onSelectDecision ? () => onSelectDecision(decision) : undefined}
            className={cn(
              'w-full flex items-center gap-3 p-2 rounded-lg',
              'hover:bg-white/5 transition-colors text-left'
            )}
          >
            {/* Node */}
            <div className="relative flex flex-col items-center">
              <div
                className={cn('h-2.5 w-2.5 rounded-full', colors.nodeClass)}
                style={{
                  boxShadow: `0 0 6px ${colors.glowClass.includes('emerald') ? 'rgba(52, 211, 153, 0.5)' : colors.glowClass.includes('rose') ? 'rgba(244, 63, 94, 0.5)' : 'rgba(107, 114, 128, 0.3)'}`,
                }}
              />
              {index < sortedDecisions.length - 1 && (
                <div className="w-px h-4 bg-white/10 mt-1" />
              )}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <p
                className={cn(
                  'text-sm truncate',
                  decision.status !== 'active' && 'line-through text-muted-foreground'
                )}
              >
                {decision.title}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </p>
            </div>
          </button>
        )
      })}

      {decisions.length > maxItems && (
        <p className="text-xs text-muted-foreground text-center">
          +{decisions.length - maxItems} more
        </p>
      )}
    </div>
  )
}
