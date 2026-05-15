import type { TaskStatus } from "@/lib/assistant/types";
import { StatusBadge } from "@ui/custom";
import { Ban, CheckCircle, Circle, Play } from "lucide-react";

const statusConfig: Record<
    TaskStatus,
    {
        label: string;
        bgClass: string;
        textClass: string;
        borderClass: string;
        icon: React.ReactNode;
    }
> = {
    backlog: {
        label: "Backlog",
        bgClass: "bg-gray-500/10",
        textClass: "text-gray-400",
        borderClass: "border-gray-500/30",
        icon: <Circle className="h-3 w-3" />,
    },
    "in-progress": {
        label: "In Progress",
        bgClass: "bg-blue-500/10",
        textClass: "text-blue-400",
        borderClass: "border-blue-500/30",
        icon: <Play className="h-3 w-3" />,
    },
    blocked: {
        label: "Blocked",
        bgClass: "bg-red-500/10",
        textClass: "text-red-400",
        borderClass: "border-red-500/30",
        icon: <Ban className="h-3 w-3" />,
    },
    completed: {
        label: "Completed",
        bgClass: "bg-green-500/10",
        textClass: "text-green-400",
        borderClass: "border-green-500/30",
        icon: <CheckCircle className="h-3 w-3" />,
    },
};

interface TaskStatusBadgeProps {
    status: TaskStatus;
    size?: "xs" | "sm";
    className?: string;
}

/**
 * TaskStatusBadge — domain-aware StatusBadge wrapper for TaskStatus enum.
 * Maps each status to its neon tint + icon via a static config table.
 */
export function TaskStatusBadge({ status, size = "sm", className }: TaskStatusBadgeProps) {
    const config = statusConfig[status];

    return (
        <StatusBadge
            bgClass={config.bgClass}
            textClass={config.textClass}
            borderClass={config.borderClass}
            icon={config.icon}
            size={size}
            className={className}
        >
            {config.label}
        </StatusBadge>
    );
}
