import { Link } from "@tanstack/react-router";
import { Button } from "@ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { AlertBlock, RiskIndicator, TaskMetaRow } from "@ui/custom";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@ui/custom/feature-card-nexus";
import { AlertTriangle, Ban, CheckCircle, Circle, MoreVertical, Play, Trash2 } from "lucide-react";
import type { DeadlineRiskLevel, Task, TaskStatus, UrgencyLevel } from "@/lib/assistant/types";
import { getUrgencyColor } from "@/lib/assistant/types";
import { formatFocusTime } from "@/lib/assistant/utils";
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
    const visibleRiskLevel = riskLevel && riskLevel !== "green" ? riskLevel : null;
    const showRiskIndicator = Boolean(visibleRiskLevel);
    const riskMenuColor = riskLevel === "red" ? "text-red-400" : "text-yellow-400";
    const deadlineLabel = task.deadline ? formatDeadlineRelative(new Date(task.deadline)) : "No deadline";
    const deadlineOverdue = Boolean(task.deadline && new Date(task.deadline) < new Date());

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
                        {visibleRiskLevel && (
                            <RiskIndicator
                                level={visibleRiskLevel}
                                label={
                                    daysLate > 0
                                        ? `${visibleRiskLevel === "red" ? "Critical" : "At Risk"} +${daysLate}d`
                                        : undefined
                                }
                                onClick={onRiskClick ? () => onRiskClick(task.id) : undefined}
                            />
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
                                            <AlertTriangle className={cn("mr-2 h-4 w-4", riskMenuColor)} />
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
                    <TaskMetaRow
                        deadline={deadlineLabel}
                        deadlineClassName={cn(deadlineOverdue && "text-red-400 font-medium")}
                        focusTimeLabel={formatFocusTime(task.focusTimeLogged, "--")}
                        className="w-full justify-between"
                    />
                </div>

                {/* Context parking indicator */}
                {task.contextParkingLot && (
                    <AlertBlock color="purple" size="sm" className="mt-3 p-2">
                        <p className="text-[11px] text-purple-300 line-clamp-2">
                            <span className="font-semibold">Parked:</span> {task.contextParkingLot}
                        </p>
                    </AlertBlock>
                )}
            </FeatureCardContent>
        </FeatureCard>
    );
}
