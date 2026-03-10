import { ArrowRight, Calendar, Check, ChevronDown, ChevronUp, Eye, FileText, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Decision, HandoffDocument, TaskBlocker } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { HandoffDocument as HandoffDocumentView } from "./HandoffDocument";

interface HandoffBannerProps {
    handoff: HandoffDocument;
    decisions?: Decision[];
    blockers?: TaskBlocker[];
    onAcknowledge: () => void;
    onDismiss?: () => void;
    className?: string;
}

/**
 * HandoffBanner - Notification banner for received handoffs
 *
 * Shown at the top of task detail when a task was handed off to the current user.
 * Features:
 * - "Task handed off to you from @sender" message
 * - Expandable to see full document
 * - Acknowledge button to mark as reviewed
 */
export function HandoffBanner({
    handoff,
    decisions = [],
    blockers = [],
    onAcknowledge,
    onDismiss,
    className,
}: HandoffBannerProps) {
    const [expanded, setExpanded] = useState(false);
    const [showFullDocument, setShowFullDocument] = useState(false);
    const [acknowledging, setAcknowledging] = useState(false);

    function formatDate(date: Date): string {
        return new Date(date).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
    }

    async function handleAcknowledge() {
        setAcknowledging(true);
        try {
            await onAcknowledge();
        } finally {
            setAcknowledging(false);
        }
    }

    // Get linked decisions and blockers
    const linkedDecisions = decisions.filter((d) => handoff.decisions.includes(d.id));
    const linkedBlockers = blockers.filter((b) => handoff.blockers.includes(b.id));

    return (
        <>
            <div
                className={cn(
                    "rounded-xl overflow-hidden",
                    "bg-gradient-to-r from-cyan-500/10 via-purple-500/10 to-cyan-500/10",
                    "border border-cyan-500/30",
                    "shadow-lg shadow-cyan-500/10",
                    className
                )}
            >
                {/* Main banner */}
                <div className="p-4">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                            {/* Icon */}
                            <div className="flex-shrink-0 h-10 w-10 rounded-full bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center">
                                <FileText className="h-5 w-5 text-cyan-400" />
                            </div>

                            {/* Content */}
                            <div>
                                <h4 className="font-semibold text-cyan-300">Task Handed Off to You</h4>
                                <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground font-mono">
                                    <span>From</span>
                                    <span className="text-purple-400 font-semibold">{handoff.handedOffFrom}</span>
                                    <ArrowRight className="h-3 w-3" />
                                    <span className="text-emerald-400 font-semibold">You</span>
                                    <span className="text-muted-foreground">|</span>
                                    <Calendar className="h-3 w-3" />
                                    <span>{formatDate(new Date(handoff.handoffAt))}</span>
                                </div>

                                {/* Quick stats */}
                                <div className="flex items-center gap-2 mt-2">
                                    {linkedDecisions.length > 0 && (
                                        <span className="text-xs px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 font-mono">
                                            {linkedDecisions.length} decisions
                                        </span>
                                    )}
                                    {linkedBlockers.length > 0 && (
                                        <span className="text-xs px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono">
                                            {linkedBlockers.length} blockers
                                        </span>
                                    )}
                                    {handoff.nextSteps.length > 0 && (
                                        <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                                            {handoff.nextSteps.length} next steps
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setExpanded(!expanded)}
                                className="gap-1 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
                            >
                                {expanded ? (
                                    <>
                                        <ChevronUp className="h-4 w-4" />
                                        Less
                                    </>
                                ) : (
                                    <>
                                        <ChevronDown className="h-4 w-4" />
                                        More
                                    </>
                                )}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setShowFullDocument(true)}
                                className="gap-1 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
                            >
                                <Eye className="h-4 w-4" />
                                View
                            </Button>
                            <Button
                                size="sm"
                                onClick={handleAcknowledge}
                                disabled={acknowledging}
                                className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                            >
                                <Check className="h-4 w-4" />
                                {acknowledging ? "Acknowledging..." : "Acknowledge"}
                            </Button>
                            {onDismiss && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={onDismiss}
                                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Expanded preview */}
                {expanded && (
                    <div className="px-4 pb-4 pt-0">
                        <div className="p-4 rounded-lg bg-black/30 border border-cyan-500/20 space-y-3">
                            {/* Summary */}
                            <div>
                                <h5 className="text-xs font-mono text-cyan-400 uppercase tracking-wider mb-1">
                                    Summary
                                </h5>
                                <p className="text-sm text-foreground/90">{handoff.summary}</p>
                            </div>

                            {/* Context preview */}
                            <div>
                                <h5 className="text-xs font-mono text-cyan-400 uppercase tracking-wider mb-1">
                                    Context
                                </h5>
                                <p className="text-sm text-foreground/80 font-mono line-clamp-3 whitespace-pre-wrap">
                                    {handoff.contextNotes}
                                </p>
                            </div>

                            {/* Next steps preview */}
                            {handoff.nextSteps.length > 0 && (
                                <div>
                                    <h5 className="text-xs font-mono text-emerald-400 uppercase tracking-wider mb-1">
                                        Next Steps
                                    </h5>
                                    <div className="space-y-1">
                                        {handoff.nextSteps.slice(0, 3).map((step, index) => (
                                            <div key={index} className="flex items-start gap-2 text-sm">
                                                <div className="h-4 w-4 rounded border border-emerald-500/50 flex-shrink-0 mt-0.5" />
                                                <span className="text-foreground/80 font-mono">{step}</span>
                                            </div>
                                        ))}
                                        {handoff.nextSteps.length > 3 && (
                                            <p className="text-xs text-muted-foreground pl-6">
                                                +{handoff.nextSteps.length - 3} more steps
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Gotchas preview */}
                            {handoff.gotchas && (
                                <div>
                                    <h5 className="text-xs font-mono text-amber-400 uppercase tracking-wider mb-1">
                                        Watch Out For
                                    </h5>
                                    <p className="text-sm text-foreground/80 font-mono line-clamp-2">
                                        {handoff.gotchas}
                                    </p>
                                </div>
                            )}

                            {/* Contact */}
                            <div>
                                <h5 className="text-xs font-mono text-cyan-400 uppercase tracking-wider mb-1">
                                    Contact
                                </h5>
                                <p className="text-sm text-foreground/80 font-mono">{handoff.contact}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Full document modal */}
            {showFullDocument && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowFullDocument(false)}
                            className="absolute top-4 right-4 z-10 text-cyan-400 hover:bg-cyan-500/10"
                        >
                            <span className="sr-only">Close</span>
                            <X className="h-5 w-5" />
                        </Button>
                        <HandoffDocumentView handoff={handoff} decisions={linkedDecisions} blockers={linkedBlockers} />
                    </div>
                </div>
            )}
        </>
    );
}

/**
 * Compact handoff notification for task list
 */
export function HandoffNotification({
    handoff,
    onClick,
    className,
}: {
    handoff: HandoffDocument;
    onClick?: () => void;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "w-full text-left p-2 rounded-lg transition-all",
                "bg-cyan-500/10 border border-cyan-500/20",
                "hover:bg-cyan-500/20 hover:border-cyan-500/30",
                className
            )}
        >
            <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-cyan-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-cyan-300 truncate">
                        Handed off from {handoff.handedOffFrom}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-mono truncate">
                        {handoff.nextSteps.length} steps | {handoff.summary}
                    </p>
                </div>
                <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            </div>
        </button>
    );
}
