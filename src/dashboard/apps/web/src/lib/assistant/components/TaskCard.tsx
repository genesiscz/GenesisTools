import { Link } from "@tanstack/react-router";
import { AlertTriangle, Ban, Calendar, CheckCircle, Circle, Clock, MoreVertical, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@/components/ui/feature-card";
import type { DeadlineRiskLevel, Task, TaskStatus, UrgencyLevel } from "@/lib/assistant/types";
import { getUrgencyColor } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface TaskCardProps {
    task: Task;
    riskLevel?: DeadlineRiskLevel;
    daysLate?: number;
    onComplete?: (taskId: string) => void;
    onDelete?: (taskId: string) => void;
    onStartWork?: (taskId: string) => void;
    onRiskClick?: (taskId: string) => void;
    className?: string;
}

/**
 * Get status icon and styling
 */
function getStatusInfo(status: TaskStatus): {
    icon: typeof Circle;
    label: string;
    colorClass: string;
} {
    switch (status) {
        case "backlog":
            return { icon: Circle, label: "Backlog", colorClass: "text-gray-400" };
        case "in-progress":
            return { icon: Play, label: "In Progress", colorClass: "text-blue-400" };
        case "blocked":
            return { icon: Ban, label: "Blocked", colorClass: "text-red-400" };
        case "completed":
            return { icon: CheckCircle, label: "Completed", colorClass: "text-green-400" };
    }
}

/**
 * Get urgency label and styling
 */
function getUrgencyInfo(urgency: UrgencyLevel): {
    label: string;
    colorClass: string;
    bgClass: string;
    borderClass: string;
} {
    const colors = getUrgencyColor(urgency);
    switch (urgency) {
        case "critical":
            return {
                label: "Critical",
                colorClass: colors.text,
                bgClass: colors.bg,
                borderClass: colors.border,
            };
        case "important":
            return {
                label: "Important",
                colorClass: colors.text,
                bgClass: colors.bg,
                borderClass: colors.border,
            };
        case "nice-to-have":
            return {
                label: "Nice to Have",
                colorClass: colors.text,
                bgClass: colors.bg,
                borderClass: colors.border,
            };
    }
}

/**
 * Format relative time (e.g., "2 days", "5 hours")
 */
function formatDeadlineRelative(deadline: Date): string {
    const now = new Date();
    const diff = deadline.getTime() - now.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diff / (1000 * 60 * 60));

    if (diff < 0) {
        const absDays = Math.abs(days);
        if (absDays === 0) {
            return "Overdue";
        }
        return `${absDays} day${absDays !== 1 ? "s" : ""} overdue`;
    }

    if (days === 0) {
        if (hours <= 1) {
            return "Due soon";
        }
        return `${hours} hour${hours !== 1 ? "s" : ""}`;
    }

    return `${days} day${days !== 1 ? "s" : ""}`;
}

/**
 * Format focus time (e.g., "2h 30m")
 */
function formatFocusTime(minutes: number): string {
    if (minutes === 0) {
        return "--";
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours === 0) {
        return `${mins}m`;
    }
    if (mins === 0) {
        return `${hours}h`;
    }
    return `${hours}h ${mins}m`;
}

/**
 * Map urgency to FeatureCard color
 */
function getCardColor(urgency: UrgencyLevel): "rose" | "amber" | "primary" {
    switch (urgency) {
        case "critical":
            return "rose";
        case "important":
            return "amber";
        case "nice-to-have":
            return "primary";
    }
}

/**
 * Risk indicator configuration
 */
const riskConfig: Record<
    DeadlineRiskLevel,
    {
        label: string;
        colorClass: string;
        bgClass: string;
        borderClass: string;
        dotColor: string;
        glowColor: string;
    }
> = {
    green: {
        label: "On Track",
        colorClass: "text-green-400",
        bgClass: "bg-green-500/10",
        borderClass: "border-green-500/30",
        dotColor: "bg-green-500",
        glowColor: "",
    },
    yellow: {
        label: "At Risk",
        colorClass: "text-yellow-400",
        bgClass: "bg-yellow-500/10",
        borderClass: "border-yellow-500/30",
        dotColor: "bg-yellow-500",
        glowColor: "rgba(234, 179, 8, 0.4)",
    },
    red: {
        label: "Critical",
        colorClass: "text-red-400",
        bgClass: "bg-red-500/10",
        borderClass: "border-red-500/30",
        dotColor: "bg-red-500",
        glowColor: "rgba(239, 68, 68, 0.5)",
    },
};

/**
 * TaskCard component - Displays a task with urgency color coding
 */
export function TaskCard({
    task,
    riskLevel,
    daysLate = 0,
    onComplete,
    onDelete,
    onStartWork,
    onRiskClick,
    className,
}: TaskCardProps) {
    const urgencyInfo = getUrgencyInfo(task.urgencyLevel);
    const statusInfo = getStatusInfo(task.status);
    const StatusIcon = statusInfo.icon;
    const isCompleted = task.status === "completed";
    const cardColor = getCardColor(task.urgencyLevel);

    // Show risk indicator for yellow and red risks
    const showRiskIndicator = riskLevel && riskLevel !== "green";
    const riskInfo = riskLevel ? riskConfig[riskLevel] : null;

    return (
        <FeatureCard
            color={cardColor}
            className={cn("h-full transition-all duration-200", isCompleted && "opacity-60", className)}
        >
            <FeatureCardHeader className="pb-2">
                {/* Header row: Status + Urgency + Risk + Menu */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <StatusIcon className={cn("h-4 w-4", statusInfo.colorClass)} />
                        <span className={cn("text-xs font-medium", statusInfo.colorClass)}>{statusInfo.label}</span>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Risk indicator */}
                        {showRiskIndicator && riskInfo && (
                            <button
                                onClick={() => onRiskClick?.(task.id)}
                                className={cn(
                                    "flex items-center gap-1.5 px-2 py-0.5 rounded-full",
                                    "transition-all duration-200",
                                    "border",
                                    riskInfo.bgClass,
                                    riskInfo.borderClass,
                                    onRiskClick && "cursor-pointer hover:scale-105",
                                    riskLevel === "red" && "hover:shadow-lg hover:shadow-red-500/20",
                                    riskLevel === "yellow" && "hover:shadow-lg hover:shadow-yellow-500/20"
                                )}
                            >
                                {/* Animated dot */}
                                <span className="relative">
                                    <span
                                        className={cn(
                                            "block h-1.5 w-1.5 rounded-full",
                                            riskInfo.dotColor,
                                            riskLevel === "red" && "animate-pulse"
                                        )}
                                        style={{
                                            boxShadow: riskInfo.glowColor ? `0 0 8px ${riskInfo.glowColor}` : undefined,
                                        }}
                                    />
                                    {riskLevel === "red" && (
                                        <span
                                            className="absolute inset-0 rounded-full border border-red-400 animate-ping"
                                            style={{ animationDuration: "2s" }}
                                        />
                                    )}
                                </span>
                                <span className={cn("text-[10px] font-medium", riskInfo.colorClass)}>
                                    {riskInfo.label}
                                </span>
                                {daysLate > 0 && (
                                    <span className="text-[10px] text-red-400 font-semibold">+{daysLate}d</span>
                                )}
                            </button>
                        )}

                        {/* Urgency badge */}
                        <span
                            className={cn(
                                "text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide",
                                urgencyInfo.bgClass,
                                urgencyInfo.colorClass,
                                "border",
                                urgencyInfo.borderClass
                            )}
                        >
                            {urgencyInfo.label}
                        </span>

                        {/* Actions menu */}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-white/10">
                                    <MoreVertical className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-40">
                                {!isCompleted && onComplete && (
                                    <DropdownMenuItem onClick={() => onComplete(task.id)}>
                                        <CheckCircle className="mr-2 h-4 w-4 text-green-400" />
                                        Complete
                                    </DropdownMenuItem>
                                )}
                                {task.status === "backlog" && onStartWork && (
                                    <DropdownMenuItem onClick={() => onStartWork(task.id)}>
                                        <Play className="mr-2 h-4 w-4 text-blue-400" />
                                        Start Work
                                    </DropdownMenuItem>
                                )}
                                {showRiskIndicator && onRiskClick && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={() => onRiskClick(task.id)}>
                                            <AlertTriangle className={cn("mr-2 h-4 w-4", riskInfo?.colorClass)} />
                                            Handle Risk
                                        </DropdownMenuItem>
                                    </>
                                )}
                                <DropdownMenuSeparator />
                                {onDelete && (
                                    <DropdownMenuItem
                                        onClick={() => onDelete(task.id)}
                                        className="text-red-400 focus:text-red-400"
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>

                {/* Task title - clickable link to detail */}
                <Link to="/assistant/tasks/$taskId" params={{ taskId: task.id }} className="group/link">
                    <h3
                        className={cn(
                            "text-base font-semibold leading-snug line-clamp-2 transition-colors",
                            "group-hover/link:text-purple-400",
                            isCompleted && "line-through text-muted-foreground"
                        )}
                    >
                        {task.title}
                    </h3>
                </Link>

                {/* Description preview */}
                {task.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{task.description}</p>
                )}
            </FeatureCardHeader>

            <FeatureCardContent className="pt-2">
                {/* Footer: Deadline + Focus time */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                    {/* Deadline */}
                    <div className="flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />
                        {task.deadline ? (
                            <span className={cn(new Date(task.deadline) < new Date() && "text-red-400 font-medium")}>
                                {formatDeadlineRelative(new Date(task.deadline))}
                            </span>
                        ) : (
                            <span>No deadline</span>
                        )}
                    </div>

                    {/* Focus time */}
                    <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />
                        <span>{formatFocusTime(task.focusTimeLogged)}</span>
                    </div>
                </div>

                {/* Context parking indicator */}
                {task.contextParkingLot && (
                    <div className="mt-3 p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                        <p className="text-[11px] text-purple-300 line-clamp-2">
                            <span className="font-semibold">Parked:</span> {task.contextParkingLot}
                        </p>
                    </div>
                )}
            </FeatureCardContent>
        </FeatureCard>
    );
}
