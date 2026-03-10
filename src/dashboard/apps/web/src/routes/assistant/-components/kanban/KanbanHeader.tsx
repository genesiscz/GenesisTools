import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskStatus } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface KanbanHeaderProps {
    status: TaskStatus;
    count: number;
    onAddTask?: () => void;
    className?: string;
}

/**
 * Column configuration with colors and labels
 */
export const COLUMN_CONFIG: Record<
    TaskStatus,
    {
        label: string;
        color: string;
        borderColor: string;
        bgColor: string;
        textColor: string;
        dotColor: string;
        glowColor: string;
    }
> = {
    backlog: {
        label: "Backlog",
        color: "cyan",
        borderColor: "border-cyan-500/30",
        bgColor: "bg-cyan-500/10",
        textColor: "text-cyan-400",
        dotColor: "bg-cyan-500",
        glowColor: "shadow-cyan-500/20",
    },
    "in-progress": {
        label: "In Progress",
        color: "amber",
        borderColor: "border-amber-500/30",
        bgColor: "bg-amber-500/10",
        textColor: "text-amber-400",
        dotColor: "bg-amber-500",
        glowColor: "shadow-amber-500/20",
    },
    blocked: {
        label: "Blocked",
        color: "rose",
        borderColor: "border-rose-500/30",
        bgColor: "bg-rose-500/10",
        textColor: "text-rose-400",
        dotColor: "bg-rose-500",
        glowColor: "shadow-rose-500/20",
    },
    completed: {
        label: "Completed",
        color: "emerald",
        borderColor: "border-emerald-500/30",
        bgColor: "bg-emerald-500/10",
        textColor: "text-emerald-400",
        dotColor: "bg-emerald-500",
        glowColor: "shadow-emerald-500/20",
    },
};

/**
 * KanbanHeader - Column header with count badge and quick add button
 */
export function KanbanHeader({ status, count, onAddTask, className }: KanbanHeaderProps) {
    const config = COLUMN_CONFIG[status];

    return (
        <div
            className={cn(
                "flex items-center justify-between px-3 py-2.5",
                "rounded-t-lg border-b",
                "bg-[#0a0a14]/60 backdrop-blur-sm",
                config.borderColor,
                className
            )}
        >
            <div className="flex items-center gap-2.5">
                {/* Status dot */}
                <div className={cn("h-2.5 w-2.5 rounded-full", config.dotColor, count > 0 && "animate-pulse")} />

                {/* Label */}
                <span className={cn("text-sm font-semibold tracking-wide", config.textColor)}>{config.label}</span>

                {/* Count badge */}
                <span
                    className={cn(
                        "flex items-center justify-center",
                        "min-w-[20px] h-5 px-1.5 rounded-full",
                        "text-[10px] font-bold",
                        config.bgColor,
                        config.textColor,
                        "border",
                        config.borderColor
                    )}
                >
                    {count}
                </span>
            </div>

            {/* Quick add button */}
            {onAddTask && status !== "completed" && (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onAddTask}
                    className={cn(
                        "h-6 w-6 p-0",
                        "hover:bg-white/10",
                        config.textColor,
                        "opacity-60 hover:opacity-100 transition-opacity"
                    )}
                    title={`Add task to ${config.label}`}
                >
                    <Plus className="h-4 w-4" />
                </Button>
            )}
        </div>
    );
}
