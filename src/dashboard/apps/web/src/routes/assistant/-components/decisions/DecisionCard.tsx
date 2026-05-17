import { Button } from "@ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { AlertBlock, MetaItem, MetaRow, StatusBadge, TagChip } from "@ui/custom";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@ui/custom/feature-card-nexus";
import {
    ArrowRightCircle,
    Calendar,
    ChevronDown,
    ChevronRight,
    Link as LinkIcon,
    MoreVertical,
    Pencil,
    RotateCcw,
    Scale,
    Tag,
    Trash2,
    User,
} from "lucide-react";
import { useState } from "react";
import type { Decision, DecisionImpactArea, DecisionStatus } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface DecisionCardProps {
    decision: Decision;
    onSupersede?: (decisionId: string) => void;
    onReverse?: (decisionId: string) => void;
    onEdit?: (decision: Decision) => void;
    onDelete?: (decisionId: string) => void;
    onViewChain?: (decisionId: string) => void;
    className?: string;
}

/**
 * Status configuration with cyberpunk colors
 */
const statusConfig: Record<
    DecisionStatus,
    {
        label: string;
        colorClass: string;
        bgClass: string;
        borderClass: string;
        cardColor: "emerald" | "primary" | "rose";
    }
> = {
    active: {
        label: "Active",
        colorClass: "text-emerald-400",
        bgClass: "bg-emerald-500/10",
        borderClass: "border-emerald-500/30",
        cardColor: "emerald",
    },
    superseded: {
        label: "Superseded",
        colorClass: "text-gray-400",
        bgClass: "bg-gray-500/10",
        borderClass: "border-gray-500/30",
        cardColor: "primary",
    },
    reversed: {
        label: "Reversed",
        colorClass: "text-rose-400",
        bgClass: "bg-rose-500/10",
        borderClass: "border-rose-500/30",
        cardColor: "rose",
    },
};

/**
 * Impact area configuration
 */
const impactAreaConfig: Record<
    DecisionImpactArea,
    {
        label: string;
        colorClass: string;
        bgClass: string;
        borderClass: string;
    }
> = {
    frontend: {
        label: "Frontend",
        colorClass: "text-purple-400",
        bgClass: "bg-purple-500/10",
        borderClass: "border-purple-500/30",
    },
    backend: {
        label: "Backend",
        colorClass: "text-blue-400",
        bgClass: "bg-blue-500/10",
        borderClass: "border-blue-500/30",
    },
    infrastructure: {
        label: "Infrastructure",
        colorClass: "text-orange-400",
        bgClass: "bg-orange-500/10",
        borderClass: "border-orange-500/30",
    },
    process: {
        label: "Process",
        colorClass: "text-cyan-400",
        bgClass: "bg-cyan-500/10",
        borderClass: "border-cyan-500/30",
    },
    architecture: {
        label: "Architecture",
        colorClass: "text-amber-400",
        bgClass: "bg-amber-500/10",
        borderClass: "border-amber-500/30",
    },
    product: {
        label: "Product",
        colorClass: "text-emerald-400",
        bgClass: "bg-emerald-500/10",
        borderClass: "border-emerald-500/30",
    },
};

/**
 * Format date for display
 */
function formatDate(date: Date): string {
    return new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

/**
 * DecisionCard component - Displays a decision with expandable details
 */
export function DecisionCard({
    decision,
    onSupersede,
    onReverse,
    onEdit,
    onDelete,
    onViewChain,
    className,
}: DecisionCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    const statusInfo = statusConfig[decision.status];
    const impactInfo = impactAreaConfig[decision.impactArea];
    const isInactive = decision.status !== "active";

    return (
        <FeatureCard
            color={statusInfo.cardColor}
            className={cn("h-full transition-all duration-200", isInactive && "opacity-70", className)}
        >
            <FeatureCardHeader className="pb-2">
                {/* Header row: Status + Impact Area + Menu */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        {/* Status badge */}
                        <StatusBadge
                            bgClass={statusInfo.bgClass}
                            textClass={statusInfo.colorClass}
                            borderClass={statusInfo.borderClass}
                            icon={
                                <span
                                    className={cn(
                                        "inline-block h-1.5 w-1.5 rounded-full",
                                        decision.status === "active" && "bg-emerald-400",
                                        decision.status === "superseded" && "bg-gray-400",
                                        decision.status === "reversed" && "bg-rose-400"
                                    )}
                                />
                            }
                        >
                            {statusInfo.label}
                        </StatusBadge>

                        {/* Impact area badge */}
                        <StatusBadge
                            bgClass={impactInfo.bgClass}
                            textClass={impactInfo.colorClass}
                            borderClass={impactInfo.borderClass}
                            uppercase={false}
                        >
                            {impactInfo.label}
                        </StatusBadge>
                    </div>

                    {/* Actions menu */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-white/10">
                                <MoreVertical className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                            {decision.status === "active" && onSupersede && (
                                <DropdownMenuItem onClick={() => onSupersede(decision.id)}>
                                    <ArrowRightCircle className="mr-2 h-4 w-4 text-amber-400" />
                                    Supersede
                                </DropdownMenuItem>
                            )}
                            {decision.status === "active" && onReverse && (
                                <DropdownMenuItem onClick={() => onReverse(decision.id)}>
                                    <RotateCcw className="mr-2 h-4 w-4 text-rose-400" />
                                    Reverse
                                </DropdownMenuItem>
                            )}
                            {decision.supersededBy && onViewChain && (
                                <DropdownMenuItem onClick={() => onViewChain(decision.id)}>
                                    <LinkIcon className="mr-2 h-4 w-4 text-purple-400" />
                                    View Chain
                                </DropdownMenuItem>
                            )}
                            {onEdit && (
                                <DropdownMenuItem onClick={() => onEdit(decision)}>
                                    <Pencil className="mr-2 h-4 w-4 text-blue-400" />
                                    Edit
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            {onDelete && (
                                <DropdownMenuItem
                                    onClick={() => onDelete(decision.id)}
                                    className="text-red-400 focus:text-red-400"
                                >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                {/* Decision title */}
                <div className="flex items-start gap-2">
                    <Scale className={cn("h-5 w-5 mt-0.5 flex-shrink-0", statusInfo.colorClass)} />
                    <h3
                        className={cn(
                            "text-base font-semibold leading-snug line-clamp-2",
                            isInactive && "line-through text-muted-foreground"
                        )}
                    >
                        {decision.title}
                    </h3>
                </div>

                {/* Meta info row */}
                <MetaRow className="mt-3">
                    <MetaItem icon={<Calendar />}>{formatDate(decision.decidedAt)}</MetaItem>
                    <MetaItem icon={<User />}>{decision.decidedBy}</MetaItem>
                </MetaRow>
            </FeatureCardHeader>

            <FeatureCardContent className="pt-2">
                {/* Expand/collapse button */}
                <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
                >
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="font-medium">{isExpanded ? "Hide details" : "Show reasoning & alternatives"}</span>
                </button>

                {/* Expandable content */}
                <div
                    className={cn(
                        "overflow-hidden transition-all duration-300 ease-in-out",
                        isExpanded ? "max-h-[500px] opacity-100 mt-4" : "max-h-0 opacity-0"
                    )}
                >
                    {/* Reasoning */}
                    <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Reasoning
                        </h4>
                        <p className="text-sm text-foreground/90 whitespace-pre-wrap">{decision.reasoning}</p>
                    </div>

                    {/* Alternatives */}
                    {decision.alternativesConsidered.length > 0 && (
                        <div className="space-y-2 mt-4">
                            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Alternatives Considered
                            </h4>
                            <ul className="space-y-1.5">
                                {decision.alternativesConsidered.map((alt, index) => (
                                    <li key={index} className="flex items-start gap-2 text-sm text-foreground/80">
                                        <span className="text-muted-foreground">-</span>
                                        <span>{alt}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Reversal reason (if reversed) */}
                    {decision.status === "reversed" && decision.reversalReason && (
                        <AlertBlock color="rose" className="space-y-2 mt-4">
                            <h4 className="text-xs font-semibold text-rose-400 uppercase tracking-wide">
                                Reversal Reason
                            </h4>
                            <p className="text-sm text-rose-300">{decision.reversalReason}</p>
                        </AlertBlock>
                    )}

                    {/* Tags */}
                    {decision.tags.length > 0 && (
                        <div className="flex items-center gap-2 mt-4 flex-wrap">
                            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                            {decision.tags.map((tag) => (
                                <TagChip key={tag}>{tag}</TagChip>
                            ))}
                        </div>
                    )}

                    {/* Related tasks count */}
                    {decision.relatedTaskIds.length > 0 && (
                        <div className="mt-4 text-xs text-muted-foreground">
                            Linked to {decision.relatedTaskIds.length} task
                            {decision.relatedTaskIds.length !== 1 ? "s" : ""}
                        </div>
                    )}
                </div>
            </FeatureCardContent>
        </FeatureCard>
    );
}

export { statusConfig, impactAreaConfig };
