import { useState } from 'react'
import {
  Terminal,
  Copy,
  Check,
  User,
  ArrowRight,
  Calendar,
  AlertTriangle,
  Lightbulb,
  ListChecks,
  Scale,
  Ban,
  Phone,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { HandoffDocument as HandoffDocumentType, Decision, TaskBlocker } from '@/lib/assistant/types'

interface HandoffDocumentProps {
  handoff: HandoffDocumentType
  decisions?: Decision[]
  blockers?: TaskBlocker[]
  className?: string
  onCopy?: () => void
}

/**
 * Terminal-style document section header with neon underline
 */
function SectionHeader({
  icon: Icon,
  title,
  color = 'cyan',
}: {
  icon: typeof Terminal
  title: string
  color?: 'cyan' | 'purple' | 'amber' | 'rose' | 'emerald'
}) {
  const colorClasses = {
    cyan: 'text-cyan-400 border-cyan-500/50',
    purple: 'text-purple-400 border-purple-500/50',
    amber: 'text-amber-400 border-amber-500/50',
    rose: 'text-rose-400 border-rose-500/50',
    emerald: 'text-emerald-400 border-emerald-500/50',
  }

  return (
    <div className={cn('flex items-center gap-2 pb-2 mb-3 border-b', colorClasses[color])}>
      <Icon className="h-4 w-4" />
      <span className="font-mono text-sm font-semibold uppercase tracking-wider">{title}</span>
    </div>
  )
}

/**
 * Terminal-style code block for context
 */
function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'font-mono text-sm bg-black/40 rounded-lg p-4 border border-cyan-500/20',
        'overflow-x-auto whitespace-pre-wrap',
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * HandoffDocument - Compiled handoff view styled like terminal output
 *
 * Displays a complete handoff document with:
 * - Summary (task title + description)
 * - Context Notes (from parking lot)
 * - Decisions Made (linked decisions)
 * - Blockers (current blockers)
 * - Next Steps (checklist)
 * - Gotchas (warnings)
 * - Contact info
 */
export function HandoffDocument({
  handoff,
  decisions = [],
  blockers = [],
  className,
  onCopy,
}: HandoffDocumentProps) {
  const [copied, setCopied] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['summary', 'context', 'nextSteps'])
  )

  function toggleSection(section: string) {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }

  async function handleCopy() {
    const markdown = generateMarkdown()
    await navigator.clipboard.writeText(markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    onCopy?.()
  }

  function generateMarkdown(): string {
    const lines: string[] = [
      `# HANDOFF: ${handoff.summary}`,
      '',
      `**From:** ${handoff.handedOffFrom}`,
      `**To:** ${handoff.handedOffTo}`,
      `**Date:** ${new Date(handoff.handoffAt).toLocaleDateString()}`,
      '',
      '---',
      '',
      '## Context Notes',
      '',
      handoff.contextNotes,
      '',
    ]

    if (decisions.length > 0) {
      lines.push('## Decisions Made', '')
      for (const dec of decisions) {
        lines.push(`### ${dec.title}`)
        lines.push(`- **Area:** ${dec.impactArea}`)
        lines.push(`- **Decided by:** ${dec.decidedBy}`)
        lines.push(`- **Reasoning:** ${dec.reasoning}`)
        if (dec.alternativesConsidered.length > 0) {
          lines.push(`- **Alternatives considered:** ${dec.alternativesConsidered.join(', ')}`)
        }
        lines.push('')
      }
    }

    if (blockers.length > 0) {
      lines.push('## Active Blockers', '')
      for (const blocker of blockers) {
        lines.push(`- **${blocker.reason}**`)
        if (blocker.blockerOwner) {
          lines.push(`  - Owner: ${blocker.blockerOwner}`)
        }
        lines.push(`  - Since: ${new Date(blocker.blockedSince).toLocaleDateString()}`)
        lines.push('')
      }
    }

    if (handoff.nextSteps.length > 0) {
      lines.push('## Next Steps', '')
      for (const step of handoff.nextSteps) {
        lines.push(`- [ ] ${step}`)
      }
      lines.push('')
    }

    if (handoff.gotchas) {
      lines.push('## Gotchas / Watch Out For', '')
      lines.push(handoff.gotchas)
      lines.push('')
    }

    lines.push('## Contact', '')
    lines.push(handoff.contact)

    return lines.join('\n')
  }

  function formatDate(date: Date): string {
    return new Date(date).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return (
    <div
      className={cn(
        'relative rounded-xl overflow-hidden',
        'bg-[#0a0a14]/90 backdrop-blur-md',
        'border border-cyan-500/30',
        'shadow-lg shadow-cyan-500/10',
        className
      )}
    >
      {/* Tech corner decorations */}
      <div className="absolute top-0 left-0 w-8 h-8 border-l-2 border-t-2 border-cyan-500/40 rounded-tl" />
      <div className="absolute top-0 right-0 w-8 h-8 border-r-2 border-t-2 border-cyan-500/40 rounded-tr" />
      <div className="absolute bottom-0 left-0 w-8 h-8 border-l-2 border-b-2 border-cyan-500/40 rounded-bl" />
      <div className="absolute bottom-0 right-0 w-8 h-8 border-r-2 border-b-2 border-cyan-500/40 rounded-br" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-500/20 bg-black/30">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-red-500" />
            <span className="h-3 w-3 rounded-full bg-yellow-500" />
            <span className="h-3 w-3 rounded-full bg-green-500" />
          </div>
          <div className="flex items-center gap-2 text-cyan-400">
            <Terminal className="h-4 w-4" />
            <span className="font-mono text-sm">handoff_document.md</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="gap-2 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
        >
          {copied ? (
            <>
              <Check className="h-4 w-4" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              Copy
            </>
          )}
        </Button>
      </div>

      {/* Document content */}
      <div className="p-6 space-y-6">
        {/* Title & Metadata */}
        <div>
          <h2 className="text-2xl font-bold text-cyan-400 font-mono mb-4">
            <span className="text-cyan-500/50"># </span>
            HANDOFF: {handoff.summary}
          </h2>
          <div className="flex flex-wrap gap-4 text-sm font-mono">
            <div className="flex items-center gap-2 text-muted-foreground">
              <User className="h-4 w-4 text-purple-400" />
              <span>
                <span className="text-purple-400">{handoff.handedOffFrom}</span>
                <ArrowRight className="inline h-3 w-3 mx-1" />
                <span className="text-emerald-400">{handoff.handedOffTo}</span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Calendar className="h-4 w-4 text-amber-400" />
              <span>{formatDate(new Date(handoff.handoffAt))}</span>
            </div>
          </div>
        </div>

        {/* Context Notes */}
        <CollapsibleSection
          id="context"
          icon={Terminal}
          title="Context Notes"
          color="cyan"
          expanded={expandedSections.has('context')}
          onToggle={() => toggleSection('context')}
        >
          <CodeBlock>{handoff.contextNotes}</CodeBlock>
        </CollapsibleSection>

        {/* Decisions */}
        {decisions.length > 0 && (
          <CollapsibleSection
            id="decisions"
            icon={Scale}
            title={`Decisions Made (${decisions.length})`}
            color="purple"
            expanded={expandedSections.has('decisions')}
            onToggle={() => toggleSection('decisions')}
          >
            <div className="space-y-4">
              {decisions.map((dec) => (
                <div
                  key={dec.id}
                  className="p-4 rounded-lg bg-purple-500/10 border border-purple-500/20"
                >
                  <h4 className="font-semibold text-purple-300 mb-2">{dec.title}</h4>
                  <div className="text-sm text-muted-foreground space-y-1 font-mono">
                    <p>
                      <span className="text-purple-400">area:</span> {dec.impactArea}
                    </p>
                    <p>
                      <span className="text-purple-400">decided_by:</span> {dec.decidedBy}
                    </p>
                    <p className="mt-2 text-foreground/80">{dec.reasoning}</p>
                    {dec.alternativesConsidered.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-2">
                        <span className="text-purple-400">alternatives:</span>{' '}
                        {dec.alternativesConsidered.join(', ')}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Blockers */}
        {blockers.length > 0 && (
          <CollapsibleSection
            id="blockers"
            icon={Ban}
            title={`Active Blockers (${blockers.length})`}
            color="rose"
            expanded={expandedSections.has('blockers')}
            onToggle={() => toggleSection('blockers')}
          >
            <div className="space-y-3">
              {blockers.map((blocker) => (
                <div
                  key={blocker.id}
                  className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/20"
                >
                  <p className="font-semibold text-rose-300 mb-2">{blocker.reason}</p>
                  <div className="text-sm font-mono text-muted-foreground">
                    {blocker.blockerOwner && (
                      <p>
                        <span className="text-rose-400">owner:</span> {blocker.blockerOwner}
                      </p>
                    )}
                    <p>
                      <span className="text-rose-400">since:</span>{' '}
                      {formatDate(new Date(blocker.blockedSince))}
                    </p>
                    {blocker.followUpAction && (
                      <p>
                        <span className="text-rose-400">action:</span> {blocker.followUpAction}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Next Steps */}
        {handoff.nextSteps.length > 0 && (
          <CollapsibleSection
            id="nextSteps"
            icon={ListChecks}
            title="Next Steps"
            color="emerald"
            expanded={expandedSections.has('nextSteps')}
            onToggle={() => toggleSection('nextSteps')}
          >
            <div className="space-y-2">
              {handoff.nextSteps.map((step, index) => (
                <div
                  key={index}
                  className="flex items-start gap-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
                >
                  <div className="flex-shrink-0 h-5 w-5 rounded border-2 border-emerald-500/50 mt-0.5" />
                  <span className="text-sm font-mono text-foreground/90">{step}</span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Gotchas */}
        {handoff.gotchas && (
          <CollapsibleSection
            id="gotchas"
            icon={AlertTriangle}
            title="Gotchas / Watch Out For"
            color="amber"
            expanded={expandedSections.has('gotchas')}
            onToggle={() => toggleSection('gotchas')}
          >
            <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="flex gap-3">
                <Lightbulb className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm font-mono text-foreground/90 whitespace-pre-wrap">
                  {handoff.gotchas}
                </p>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Contact */}
        <CollapsibleSection
          id="contact"
          icon={Phone}
          title="Contact"
          color="cyan"
          expanded={expandedSections.has('contact')}
          onToggle={() => toggleSection('contact')}
        >
          <CodeBlock>{handoff.contact}</CodeBlock>
        </CollapsibleSection>

        {/* Review status */}
        {handoff.reviewed && handoff.reviewedAt && (
          <div className="mt-6 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="flex items-center gap-2 text-emerald-400 font-mono text-sm">
              <Check className="h-4 w-4" />
              <span>Reviewed on {formatDate(new Date(handoff.reviewedAt))}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Collapsible section component
 */
function CollapsibleSection({
  id,
  icon: Icon,
  title,
  color,
  expanded,
  onToggle,
  children,
}: {
  id: string
  icon: typeof Terminal
  title: string
  color: 'cyan' | 'purple' | 'amber' | 'rose' | 'emerald'
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const colorClasses = {
    cyan: 'text-cyan-400 border-cyan-500/50 hover:bg-cyan-500/10',
    purple: 'text-purple-400 border-purple-500/50 hover:bg-purple-500/10',
    amber: 'text-amber-400 border-amber-500/50 hover:bg-amber-500/10',
    rose: 'text-rose-400 border-rose-500/50 hover:bg-rose-500/10',
    emerald: 'text-emerald-400 border-emerald-500/50 hover:bg-emerald-500/10',
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex items-center justify-between w-full pb-2 mb-3 border-b transition-colors',
          colorClasses[color]
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="font-mono text-sm font-semibold uppercase tracking-wider">{title}</span>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {expanded && children}
    </div>
  )
}
