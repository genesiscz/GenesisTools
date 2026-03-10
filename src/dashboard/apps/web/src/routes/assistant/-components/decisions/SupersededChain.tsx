import { ArrowRight, Scale } from "lucide-react";
import type { Decision, DecisionStatus } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface SupersededChainProps {
    chain: Decision[];
    onSelectDecision?: (decisionId: string) => void;
    className?: string;
}

/**
 * Status configuration for compact chain view
 */
const statusColors: Record<
    DecisionStatus,
    {
        dotClass: string;
        borderClass: string;
        textClass: string;
    }
> = {
    active: {
        dotClass: "bg-emerald-400",
        borderClass: "border-emerald-500/30",
        textClass: "text-emerald-400",
    },
    superseded: {
        dotClass: "bg-gray-400",
        borderClass: "border-gray-500/30",
        textClass: "text-gray-400",
    },
    reversed: {
        dotClass: "bg-rose-400",
        borderClass: "border-rose-500/30",
        textClass: "text-rose-400",
    },
};

/**
 * Format date for display
 */
function formatShortDate(date: Date): string {
    return new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
}

/**
 * Compact decision card for chain view
 */
function ChainNode({
    decision,
    isFirst,
    isLast,
    onClick,
}: {
    decision: Decision;
    isFirst: boolean;
    isLast: boolean;
    onClick?: () => void;
}) {
    const colors = statusColors[decision.status];

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "relative p-3 rounded-lg border bg-[#0a0a14]/80 backdrop-blur-sm",
                "transition-all duration-200 text-left",
                "hover:brightness-110",
                colors.borderClass,
                onClick && "cursor-pointer"
            )}
        >
            {/* Status indicator */}
            <div className="flex items-center gap-2 mb-2">
                <span className={cn("h-2 w-2 rounded-full", colors.dotClass)} />
                <span className={cn("text-[10px] font-semibold uppercase tracking-wide", colors.textClass)}>
                    {decision.status}
                </span>
                {isFirst && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 font-medium ml-auto">
                        Original
                    </span>
                )}
                {isLast && decision.status === "active" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium ml-auto">
                        Current
                    </span>
                )}
            </div>

            {/* Title */}
            <div className="flex items-start gap-2">
                <Scale className={cn("h-4 w-4 mt-0.5 flex-shrink-0", colors.textClass)} />
                <h4 className="text-sm font-medium line-clamp-2">{decision.title}</h4>
            </div>

            {/* Date */}
            <p className="text-xs text-muted-foreground mt-2">{formatShortDate(decision.decidedAt)}</p>

            {/* Reversal reason if reversed */}
            {decision.status === "reversed" && decision.reversalReason && (
                <p className="text-xs text-rose-400/80 mt-2 line-clamp-2">Reversed: {decision.reversalReason}</p>
            )}
        </button>
    );
}

/**
 * Arrow connector between nodes
 */
function ChainArrow() {
    return (
        <div className="flex items-center justify-center py-1">
            <div className="relative flex items-center">
                {/* Neon line */}
                <div
                    className="h-6 w-0.5 bg-gradient-to-b from-gray-500/20 via-purple-500/50 to-gray-500/20"
                    style={{
                        boxShadow: "0 0 8px rgba(168, 85, 247, 0.3)",
                    }}
                />
                {/* Arrow icon */}
                <ArrowRight
                    className="absolute -bottom-2 left-1/2 -translate-x-1/2 h-4 w-4 text-purple-400"
                    style={{
                        filter: "drop-shadow(0 0 4px rgba(168, 85, 247, 0.5))",
                    }}
                />
            </div>
        </div>
    );
}

/**
 * SupersededChain component - Shows decision evolution chain
 *
 * Displays a vertical chain of decisions from original to current,
 * with neon arrow connectors showing the evolution.
 */
export function SupersededChain({ chain, onSelectDecision, className }: SupersededChainProps) {
    if (chain.length === 0) {
        return null;
    }

    if (chain.length === 1) {
        return (
            <div className={cn("space-y-2", className)}>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Decision History
                </h3>
                <ChainNode
                    decision={chain[0]}
                    isFirst={true}
                    isLast={true}
                    onClick={onSelectDecision ? () => onSelectDecision(chain[0].id) : undefined}
                />
            </div>
        );
    }

    return (
        <div className={cn("space-y-2", className)}>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Decision Evolution ({chain.length} decisions)
            </h3>

            <div className="flex flex-col">
                {chain.map((decision, index) => (
                    <div key={decision.id}>
                        <ChainNode
                            decision={decision}
                            isFirst={index === 0}
                            isLast={index === chain.length - 1}
                            onClick={onSelectDecision ? () => onSelectDecision(decision.id) : undefined}
                        />
                        {index < chain.length - 1 && <ChainArrow />}
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Inline chain indicator for use in lists
 * Shows just the count with a visual indicator
 */
export function ChainIndicator({
    chainLength,
    onClick,
    className,
}: {
    chainLength: number;
    onClick?: () => void;
    className?: string;
}) {
    if (chainLength <= 1) {
        return null;
    }

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full",
                "bg-purple-500/10 border border-purple-500/20",
                "text-[10px] font-medium text-purple-400",
                "hover:bg-purple-500/20 transition-colors",
                className
            )}
            title={`Part of a chain of ${chainLength} decisions`}
        >
            <div className="flex items-center -space-x-1">
                {Array.from({ length: Math.min(chainLength, 3) }).map((_, i) => (
                    <div
                        key={i}
                        className={cn(
                            "h-2 w-2 rounded-full border border-purple-400",
                            i === chainLength - 1 ? "bg-purple-400" : "bg-purple-400/30"
                        )}
                    />
                ))}
            </div>
            <span>{chainLength} in chain</span>
        </button>
    );
}
