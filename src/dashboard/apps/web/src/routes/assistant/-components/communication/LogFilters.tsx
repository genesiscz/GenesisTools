import { Button } from "@ui/components/button";
import { TabBar, type TabDef } from "@ui/custom";
import {
    AlertTriangle,
    CheckCircle,
    Github,
    Info,
    Mail,
    MessageCircle,
    MessageSquare,
    Pencil,
    Users,
} from "lucide-react";
import type { CommunicationSentiment, CommunicationSource } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

export type FilterTab = "all" | CommunicationSentiment;

interface LogFiltersProps {
    // Tab filter
    activeTab: FilterTab;
    onTabChange: (tab: FilterTab) => void;
    tabCounts: Record<FilterTab, number>;

    // Source filter
    activeSource: CommunicationSource | "all";
    onSourceChange: (source: CommunicationSource | "all") => void;
    sourceCounts: Record<CommunicationSource | "all", number>;

    className?: string;
}

/**
 * Get source icon
 */
function getSourceIcon(source: CommunicationSource | "all") {
    switch (source) {
        case "slack":
            return MessageSquare;
        case "github":
            return Github;
        case "email":
            return Mail;
        case "meeting":
            return Users;
        case "manual":
            return Pencil;
        default:
            return MessageCircle;
    }
}

/**
 * Get source color
 */
function getSourceColor(source: CommunicationSource | "all", active: boolean) {
    if (!active) {
        return "text-muted-foreground";
    }
    switch (source) {
        case "slack":
            return "text-purple-400";
        case "github":
            return "text-gray-400";
        case "email":
            return "text-blue-400";
        case "meeting":
            return "text-emerald-400";
        case "manual":
            return "text-amber-400";
        default:
            return "text-foreground";
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
    const tabs: TabDef<FilterTab>[] = [
        { value: "all", label: "All", icon: MessageCircle, activeColor: "text-foreground" },
        { value: "decision", label: "Decisions", icon: CheckCircle, activeColor: "text-purple-400" },
        { value: "blocker", label: "Blockers", icon: AlertTriangle, activeColor: "text-red-400" },
        { value: "context", label: "Context", icon: Info, activeColor: "text-gray-400" },
    ];

    const sources: { id: CommunicationSource | "all"; label: string }[] = [
        { id: "all", label: "All" },
        { id: "slack", label: "Slack" },
        { id: "github", label: "GitHub" },
        { id: "email", label: "Email" },
        { id: "meeting", label: "Meeting" },
        { id: "manual", label: "Manual" },
    ];

    return (
        <div className={cn("space-y-4", className)}>
            {/* Tab filters */}
            <TabBar tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} counts={tabCounts} theme="tinted" />

            {/* Source filters */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground font-medium mr-1">Source:</span>
                {sources.map((source) => {
                    const isActive = activeSource === source.id;
                    const Icon = getSourceIcon(source.id);
                    const count = sourceCounts[source.id];

                    return (
                        <Button
                            key={source.id}
                            variant="ghost"
                            size="sm"
                            onClick={() => onSourceChange(source.id)}
                            className={cn(
                                "h-7 px-2 gap-1.5 text-xs",
                                isActive ? "bg-white/10 hover:bg-white/15" : "hover:bg-white/5 text-muted-foreground"
                            )}
                        >
                            <Icon className={cn("h-3.5 w-3.5", getSourceColor(source.id, isActive))} />
                            <span className={isActive ? getSourceColor(source.id, isActive) : undefined}>
                                {source.label}
                            </span>
                            {count > 0 && source.id !== "all" && (
                                <span className="text-[10px] text-muted-foreground">({count})</span>
                            )}
                        </Button>
                    );
                })}
            </div>
        </div>
    );
}
