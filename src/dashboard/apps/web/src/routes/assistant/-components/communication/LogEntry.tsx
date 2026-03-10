import {
    Calendar,
    ChevronDown,
    ChevronUp,
    Edit,
    ExternalLink,
    Github,
    Link2,
    Mail,
    MessageSquare,
    MoreVertical,
    Pencil,
    Trash2,
    Users,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CommunicationEntry, CommunicationSentiment, CommunicationSource } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface LogEntryProps {
    entry: CommunicationEntry;
    onEdit?: (entry: CommunicationEntry) => void;
    onDelete?: (id: string) => void;
    onLinkTask?: (entry: CommunicationEntry) => void;
    animationDelay?: number;
    className?: string;
}

/**
 * Get source icon and color configuration
 */
function getSourceConfig(source: CommunicationSource): {
    icon: typeof MessageSquare;
    color: string;
    bgColor: string;
    borderColor: string;
    glowColor: string;
    label: string;
} {
    switch (source) {
        case "slack":
            return {
                icon: MessageSquare,
                color: "text-purple-400",
                bgColor: "bg-purple-500/10",
                borderColor: "border-purple-500/30",
                glowColor: "hover:shadow-purple-500/10",
                label: "Slack",
            };
        case "github":
            return {
                icon: Github,
                color: "text-gray-400",
                bgColor: "bg-gray-500/10",
                borderColor: "border-gray-500/30",
                glowColor: "hover:shadow-gray-500/10",
                label: "GitHub",
            };
        case "email":
            return {
                icon: Mail,
                color: "text-blue-400",
                bgColor: "bg-blue-500/10",
                borderColor: "border-blue-500/30",
                glowColor: "hover:shadow-blue-500/10",
                label: "Email",
            };
        case "meeting":
            return {
                icon: Users,
                color: "text-emerald-400",
                bgColor: "bg-emerald-500/10",
                borderColor: "border-emerald-500/30",
                glowColor: "hover:shadow-emerald-500/10",
                label: "Meeting",
            };
        case "manual":
            return {
                icon: Pencil,
                color: "text-amber-400",
                bgColor: "bg-amber-500/10",
                borderColor: "border-amber-500/30",
                glowColor: "hover:shadow-amber-500/10",
                label: "Manual",
            };
    }
}

/**
 * Get sentiment badge styling
 */
function getSentimentConfig(sentiment: CommunicationSentiment): {
    label: string;
    color: string;
    bgColor: string;
} {
    switch (sentiment) {
        case "decision":
            return {
                label: "Decision",
                color: "text-purple-300",
                bgColor: "bg-purple-500/20 border-purple-500/30",
            };
        case "discussion":
            return {
                label: "Discussion",
                color: "text-blue-300",
                bgColor: "bg-blue-500/20 border-blue-500/30",
            };
        case "blocker":
            return {
                label: "Blocker",
                color: "text-red-300",
                bgColor: "bg-red-500/20 border-red-500/30",
            };
        case "context":
            return {
                label: "Context",
                color: "text-gray-300",
                bgColor: "bg-gray-500/20 border-gray-500/30",
            };
    }
}

/**
 * Format relative time
 */
function formatRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) {
        return "Just now";
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (hours < 24) {
        return `${hours}h ago`;
    }
    if (days < 7) {
        return `${days}d ago`;
    }

    return new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
}

/**
 * LogEntry component - Single communication log entry card
 */
export function LogEntry({ entry, onEdit, onDelete, onLinkTask, animationDelay = 0, className }: LogEntryProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const sourceConfig = getSourceConfig(entry.source);
    const sentimentConfig = getSentimentConfig(entry.sentiment);
    const SourceIcon = sourceConfig.icon;

    // Determine if content should be truncated
    const contentLength = entry.content.length;
    const shouldTruncate = contentLength > 200;

    return (
        <div
            className={cn(
                "group relative overflow-hidden rounded-xl",
                "bg-[#0a0a14]/80 backdrop-blur-sm",
                "border border-white/10",
                "transition-all duration-300",
                "hover:border-white/20",
                sourceConfig.glowColor,
                "hover:shadow-lg",
                "animate-fade-in-up",
                className
            )}
            style={{ animationDelay: `${animationDelay}ms` }}
        >
            {/* Left border accent with source color */}
            <div
                className={cn(
                    "absolute left-0 top-0 bottom-0 w-1",
                    sourceConfig.bgColor.replace("/10", "/50"),
                    "group-hover:w-1.5 transition-all duration-300"
                )}
            />

            {/* Tech corner decorations */}
            <div
                className={cn(
                    "absolute top-0 left-0 w-4 h-4 border-l-2 border-t-2 rounded-tl transition-colors",
                    sourceConfig.borderColor,
                    "group-hover:border-opacity-60"
                )}
            />
            <div
                className={cn(
                    "absolute top-0 right-0 w-4 h-4 border-r-2 border-t-2 rounded-tr transition-colors",
                    sourceConfig.borderColor,
                    "group-hover:border-opacity-60"
                )}
            />
            <div
                className={cn(
                    "absolute bottom-0 left-0 w-4 h-4 border-l-2 border-b-2 rounded-bl transition-colors",
                    sourceConfig.borderColor,
                    "group-hover:border-opacity-60"
                )}
            />
            <div
                className={cn(
                    "absolute bottom-0 right-0 w-4 h-4 border-r-2 border-b-2 rounded-br transition-colors",
                    sourceConfig.borderColor,
                    "group-hover:border-opacity-60"
                )}
            />

            <div className="p-4 pl-5">
                {/* Header row */}
                <div className="flex items-start justify-between gap-3 mb-3">
                    {/* Source icon and label */}
                    <div className="flex items-center gap-3">
                        <div
                            className={cn(
                                "flex items-center justify-center w-9 h-9 rounded-lg",
                                sourceConfig.bgColor,
                                "border",
                                sourceConfig.borderColor
                            )}
                        >
                            <SourceIcon className={cn("h-4 w-4", sourceConfig.color)} />
                        </div>
                        <div>
                            <span className={cn("text-xs font-medium", sourceConfig.color)}>{sourceConfig.label}</span>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <Calendar className="h-3 w-3" />
                                <span>{formatRelativeTime(entry.discussedAt)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                        {/* Sentiment badge */}
                        <span
                            className={cn(
                                "text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide border",
                                sentimentConfig.bgColor,
                                sentimentConfig.color
                            )}
                        >
                            {sentimentConfig.label}
                        </span>

                        {/* Menu */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-40">
                                {onEdit && (
                                    <DropdownMenuItem onClick={() => onEdit(entry)}>
                                        <Edit className="mr-2 h-4 w-4" />
                                        Edit
                                    </DropdownMenuItem>
                                )}
                                {onLinkTask && (
                                    <DropdownMenuItem onClick={() => onLinkTask(entry)}>
                                        <Link2 className="mr-2 h-4 w-4" />
                                        Link Task
                                    </DropdownMenuItem>
                                )}
                                {entry.sourceUrl && (
                                    <DropdownMenuItem asChild>
                                        <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">
                                            <ExternalLink className="mr-2 h-4 w-4" />
                                            View Source
                                        </a>
                                    </DropdownMenuItem>
                                )}
                                {onDelete && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={() => onDelete(entry.id)}
                                            className="text-red-400 focus:text-red-400"
                                        >
                                            <Trash2 className="mr-2 h-4 w-4" />
                                            Delete
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>

                {/* Title */}
                <h3 className="text-sm font-semibold text-foreground mb-2 leading-snug">{entry.title}</h3>

                {/* Content */}
                <div className="text-sm text-muted-foreground leading-relaxed">
                    {shouldTruncate && !isExpanded ? (
                        <>
                            <p className="whitespace-pre-wrap">{entry.content.slice(0, 200)}...</p>
                            <button
                                onClick={() => setIsExpanded(true)}
                                className={cn(
                                    "flex items-center gap-1 mt-2 text-xs font-medium",
                                    sourceConfig.color,
                                    "hover:underline"
                                )}
                            >
                                <ChevronDown className="h-3 w-3" />
                                Show more
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="whitespace-pre-wrap">{entry.content}</p>
                            {shouldTruncate && (
                                <button
                                    onClick={() => setIsExpanded(false)}
                                    className={cn(
                                        "flex items-center gap-1 mt-2 text-xs font-medium",
                                        sourceConfig.color,
                                        "hover:underline"
                                    )}
                                >
                                    <ChevronUp className="h-3 w-3" />
                                    Show less
                                </button>
                            )}
                        </>
                    )}
                </div>

                {/* Tags */}
                {entry.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                        {entry.tags.map((tag) => (
                            <Badge
                                key={tag}
                                variant="outline"
                                className="text-[10px] px-2 py-0 h-5 bg-white/5 border-white/10"
                            >
                                {tag}
                            </Badge>
                        ))}
                    </div>
                )}

                {/* Linked tasks indicator */}
                {entry.relatedTaskIds.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-3 text-[11px] text-muted-foreground">
                        <Link2 className="h-3 w-3" />
                        <span>
                            Linked to {entry.relatedTaskIds.length} task
                            {entry.relatedTaskIds.length !== 1 ? "s" : ""}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
