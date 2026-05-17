import { StatusBadge } from "./status-badge";

export type UrgencyLevel = "critical" | "important" | "nice-to-have";

const URGENCY_STYLES: Record<UrgencyLevel, { bg: string; text: string; border: string; label: string }> = {
    critical: { bg: "bg-red-500/20", text: "text-red-400", border: "border-red-500/30", label: "Critical" },
    important: {
        bg: "bg-orange-500/20",
        text: "text-orange-400",
        border: "border-orange-500/30",
        label: "Important",
    },
    "nice-to-have": {
        bg: "bg-emerald-500/20",
        text: "text-emerald-400",
        border: "border-emerald-500/30",
        label: "Nice to have",
    },
};

interface UrgencyBadgeProps {
    level: UrgencyLevel;
    variant?: "kanban" | "task";
    className?: string;
}

export function UrgencyBadge({ level, variant = "task", className }: UrgencyBadgeProps) {
    const config = URGENCY_STYLES[level];

    return (
        <StatusBadge
            bgClass={config.bg}
            textClass={config.text}
            borderClass={config.border}
            shape={variant === "kanban" ? "flat" : "pill"}
            size={variant === "kanban" ? "xs" : "sm"}
            className={className}
        >
            {config.label}
        </StatusBadge>
    );
}
