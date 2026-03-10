import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CommunicationEntry, CommunicationSource } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import { LogEntry } from "./LogEntry";
import { type FilterTab, LogFilters } from "./LogFilters";

interface CommunicationLogProps {
    entries: CommunicationEntry[];
    onEdit?: (entry: CommunicationEntry) => void;
    onDelete?: (id: string) => void;
    onLinkTask?: (entry: CommunicationEntry) => void;
    className?: string;
}

/**
 * CommunicationLog component - Main log view with search and filters
 */
export function CommunicationLog({ entries, onEdit, onDelete, onLinkTask, className }: CommunicationLogProps) {
    const [searchQuery, setSearchQuery] = useState("");
    const [activeTab, setActiveTab] = useState<FilterTab>("all");
    const [activeSource, setActiveSource] = useState<CommunicationSource | "all">("all");

    // Calculate counts for filters
    const tabCounts = useMemo(() => {
        const counts: Record<FilterTab, number> = {
            all: entries.length,
            decision: 0,
            discussion: 0,
            blocker: 0,
            context: 0,
        };
        for (const entry of entries) {
            counts[entry.sentiment]++;
        }
        return counts;
    }, [entries]);

    const sourceCounts = useMemo(() => {
        const counts: Record<CommunicationSource | "all", number> = {
            all: entries.length,
            slack: 0,
            github: 0,
            email: 0,
            meeting: 0,
            manual: 0,
        };
        for (const entry of entries) {
            counts[entry.source]++;
        }
        return counts;
    }, [entries]);

    // Filter entries based on search, tab, and source
    const filteredEntries = useMemo(() => {
        return entries.filter((entry) => {
            // Tab filter
            if (activeTab !== "all" && entry.sentiment !== activeTab) {
                return false;
            }

            // Source filter
            if (activeSource !== "all" && entry.source !== activeSource) {
                return false;
            }

            // Search filter
            if (searchQuery.trim()) {
                const query = searchQuery.toLowerCase();
                const matchesTitle = entry.title.toLowerCase().includes(query);
                const matchesContent = entry.content.toLowerCase().includes(query);
                const matchesTags = entry.tags.some((tag) => tag.toLowerCase().includes(query));

                if (!matchesTitle && !matchesContent && !matchesTags) {
                    return false;
                }
            }

            return true;
        });
    }, [entries, activeTab, activeSource, searchQuery]);

    // Sort by discussedAt (newest first)
    const sortedEntries = useMemo(() => {
        return [...filteredEntries].sort(
            (a, b) => new Date(b.discussedAt).getTime() - new Date(a.discussedAt).getTime()
        );
    }, [filteredEntries]);

    return (
        <div className={cn("flex flex-col", className)}>
            {/* Search bar */}
            <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                    value={searchQuery}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                    placeholder="Search communications..."
                    className="pl-10 pr-10 bg-white/5 border-white/10"
                />
                {searchQuery && (
                    <button
                        onClick={() => setSearchQuery("")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                )}
            </div>

            {/* Filters */}
            <LogFilters
                activeTab={activeTab}
                onTabChange={setActiveTab}
                tabCounts={tabCounts}
                activeSource={activeSource}
                onSourceChange={setActiveSource}
                sourceCounts={sourceCounts}
                className="mb-6"
            />

            {/* Results info */}
            <div className="flex items-center justify-between mb-4">
                <span className="text-sm text-muted-foreground">
                    {sortedEntries.length === entries.length
                        ? `${entries.length} entries`
                        : `${sortedEntries.length} of ${entries.length} entries`}
                </span>
                {(searchQuery || activeTab !== "all" || activeSource !== "all") && (
                    <button
                        onClick={() => {
                            setSearchQuery("");
                            setActiveTab("all");
                            setActiveSource("all");
                        }}
                        className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                    >
                        Clear filters
                    </button>
                )}
            </div>

            {/* Entries list */}
            <ScrollArea className="flex-1">
                <div className="space-y-3 pb-4">
                    {sortedEntries.map((entry, index) => (
                        <LogEntry
                            key={entry.id}
                            entry={entry}
                            onEdit={onEdit}
                            onDelete={onDelete}
                            onLinkTask={onLinkTask}
                            animationDelay={index * 50}
                        />
                    ))}
                </div>
            </ScrollArea>
        </div>
    );
}
