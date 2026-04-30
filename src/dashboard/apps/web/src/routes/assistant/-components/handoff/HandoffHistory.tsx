import { ArrowRight, Calendar, Check, ChevronRight, Clock, FileText, Filter, History, User } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@/components/ui/feature-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Decision, HandoffDocument, TaskBlocker } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { HandoffDocument as HandoffDocumentView } from "./HandoffDocument";

interface HandoffHistoryProps {
    handoffs: HandoffDocument[];
    decisions?: Decision[];
    blockers?: TaskBlocker[];
    className?: string;
    onViewHandoff?: (handoff: HandoffDocument) => void;
}

type FilterStatus = "all" | "pending" | "reviewed";

/**
 * Compact handoff card for list view
 */
function HandoffCard({ handoff, onClick }: { handoff: HandoffDocument; onClick: () => void }) {
    function formatDate(date: Date): string {
        return new Date(date).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    }

    function formatRelativeTime(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - new Date(date).getTime();
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) {
            return "Today";
        }
        if (days === 1) {
            return "Yesterday";
        }
        if (days < 7) {
            return `${days} days ago`;
        }
        if (days < 30) {
            return `${Math.floor(days / 7)} weeks ago`;
        }
        return formatDate(date);
    }

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "w-full text-left p-4 rounded-lg transition-all",
                "bg-black/20 border",
                handoff.reviewed
                    ? "border-emerald-500/20 hover:border-emerald-500/40"
                    : "border-amber-500/20 hover:border-amber-500/40",
                "hover:bg-black/30"
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    {/* Summary */}
                    <h4 className="font-semibold text-foreground truncate">{handoff.summary}</h4>

                    {/* Metadata row */}
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground font-mono">
                        <div className="flex items-center gap-1">
                            <User className="h-3 w-3 text-purple-400" />
                            <span className="text-purple-400">{handoff.handedOffFrom}</span>
                            <ArrowRight className="h-2.5 w-2.5" />
                            <span className="text-emerald-400">{handoff.handedOffTo}</span>
                        </div>
                        <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            <span>{formatRelativeTime(new Date(handoff.handoffAt))}</span>
                        </div>
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center gap-3 mt-2 text-xs">
                        {handoff.decisions.length > 0 && (
                            <span className="px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                                {handoff.decisions.length} decisions
                            </span>
                        )}
                        {handoff.blockers.length > 0 && (
                            <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                {handoff.blockers.length} blockers
                            </span>
                        )}
                        {handoff.nextSteps.length > 0 && (
                            <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                {handoff.nextSteps.length} steps
                            </span>
                        )}
                    </div>
                </div>

                {/* Status + Arrow */}
                <div className="flex items-center gap-2">
                    {handoff.reviewed ? (
                        <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs">
                            <Check className="h-3 w-3" />
                            <span className="font-mono">Reviewed</span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 text-amber-400 text-xs">
                            <Clock className="h-3 w-3" />
                            <span className="font-mono">Pending</span>
                        </div>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
            </div>
        </button>
    );
}

/**
 * HandoffHistory - List of past handoffs for a task
 *
 * Features:
 * - Filter by status (all, pending, reviewed)
 * - Click to view full document
 * - Shows handoff metadata (from, to, date)
 * - Badge counts for decisions, blockers, steps
 */
export function HandoffHistory({
    handoffs,
    decisions = [],
    blockers = [],
    className,
    onViewHandoff,
}: HandoffHistoryProps) {
    const [filter, setFilter] = useState<FilterStatus>("all");
    const [selectedHandoff, setSelectedHandoff] = useState<HandoffDocument | null>(null);

    // Filter handoffs
    const filteredHandoffs = handoffs.filter((h) => {
        if (filter === "pending") {
            return !h.reviewed;
        }
        if (filter === "reviewed") {
            return h.reviewed;
        }
        return true;
    });

    // Get decisions and blockers for selected handoff
    const selectedDecisions = selectedHandoff ? decisions.filter((d) => selectedHandoff.decisions.includes(d.id)) : [];
    const selectedBlockers = selectedHandoff ? blockers.filter((b) => selectedHandoff.blockers.includes(b.id)) : [];

    function handleViewHandoff(handoff: HandoffDocument) {
        setSelectedHandoff(handoff);
        onViewHandoff?.(handoff);
    }

    if (handoffs.length === 0) {
        return (
            <div className={cn("p-6 text-center", className)}>
                <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-cyan-500/10 border border-cyan-500/20 mb-3">
                    <FileText className="h-6 w-6 text-cyan-400/50" />
                </div>
                <p className="text-sm text-muted-foreground">No handoff history for this task.</p>
                <p className="text-xs text-muted-foreground mt-1">Create a handoff when passing work to a teammate.</p>
            </div>
        );
    }

    return (
        <div className={className}>
            {/* Header with filter */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-cyan-400">
                    <History className="h-5 w-5" />
                    <h3 className="font-mono font-semibold">Handoff History</h3>
                    <span className="text-xs text-muted-foreground">({handoffs.length})</span>
                </div>

                <Select value={filter} onValueChange={(v) => setFilter(v as FilterStatus)}>
                    <SelectTrigger className="w-[130px] h-8 text-xs bg-black/30 border-cyan-500/20">
                        <Filter className="h-3 w-3 mr-1" />
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="reviewed">Reviewed</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Handoff list */}
            <div className="space-y-3">
                {filteredHandoffs.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No {filter} handoffs found.</p>
                ) : (
                    filteredHandoffs.map((handoff) => (
                        <HandoffCard key={handoff.id} handoff={handoff} onClick={() => handleViewHandoff(handoff)} />
                    ))
                )}
            </div>

            {/* Selected handoff detail view */}
            {selectedHandoff && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSelectedHandoff(null)}
                            className="absolute top-4 right-4 z-10 text-cyan-400 hover:bg-cyan-500/10"
                        >
                            <span className="sr-only">Close</span>
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </Button>
                        <HandoffDocumentView
                            handoff={selectedHandoff}
                            decisions={selectedDecisions}
                            blockers={selectedBlockers}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Compact history widget for task detail sidebar
 */
export function HandoffHistoryWidget({
    handoffs,
    onViewAll,
    className,
}: {
    handoffs: HandoffDocument[];
    onViewAll?: () => void;
    className?: string;
}) {
    const pendingCount = handoffs.filter((h) => !h.reviewed).length;

    if (handoffs.length === 0) {
        return null;
    }

    return (
        <FeatureCard color="cyan" className={className}>
            <FeatureCardHeader>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <History className="h-4 w-4 text-cyan-400" />
                        <span className="text-sm font-semibold">Handoffs</span>
                        <span className="text-xs text-muted-foreground">({handoffs.length})</span>
                    </div>
                    {pendingCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-xs font-mono">
                            {pendingCount} pending
                        </span>
                    )}
                </div>
            </FeatureCardHeader>
            <FeatureCardContent className="pt-0">
                <div className="space-y-2">
                    {handoffs.slice(0, 3).map((handoff) => (
                        <div
                            key={handoff.id}
                            className={cn(
                                "p-2 rounded text-xs font-mono",
                                handoff.reviewed
                                    ? "bg-emerald-500/10 border border-emerald-500/20"
                                    : "bg-amber-500/10 border border-amber-500/20"
                            )}
                        >
                            <div className="flex items-center justify-between">
                                <span className="text-foreground/80 truncate">{handoff.summary}</span>
                                {handoff.reviewed ? (
                                    <Check className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                                ) : (
                                    <Clock className="h-3 w-3 text-amber-400 flex-shrink-0" />
                                )}
                            </div>
                            <div className="flex items-center gap-1 mt-1 text-muted-foreground">
                                <span className="text-purple-400">{handoff.handedOffFrom}</span>
                                <ArrowRight className="h-2.5 w-2.5" />
                                <span className="text-emerald-400">{handoff.handedOffTo}</span>
                            </div>
                        </div>
                    ))}
                </div>
                {handoffs.length > 3 && onViewAll && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onViewAll}
                        className="w-full mt-3 text-xs text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
                    >
                        View all {handoffs.length} handoffs
                        <ChevronRight className="h-3 w-3 ml-1" />
                    </Button>
                )}
            </FeatureCardContent>
        </FeatureCard>
    );
}
