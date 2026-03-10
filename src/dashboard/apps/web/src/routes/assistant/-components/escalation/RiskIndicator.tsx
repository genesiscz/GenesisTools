import type { DeadlineRiskLevel } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface RiskIndicatorProps {
    riskLevel: DeadlineRiskLevel;
    size?: "sm" | "md" | "lg";
    showLabel?: boolean;
    animate?: boolean;
    className?: string;
    onClick?: () => void;
}

/**
 * Risk level configuration
 */
const riskConfig: Record<
    DeadlineRiskLevel,
    {
        label: string;
        colorClass: string;
        bgClass: string;
        borderClass: string;
        glowClass: string;
        dotColor: string;
        glowColor: string;
    }
> = {
    green: {
        label: "On Track",
        colorClass: "text-green-400",
        bgClass: "bg-green-500/10",
        borderClass: "border-green-500/30",
        glowClass: "",
        dotColor: "bg-green-500",
        glowColor: "",
    },
    yellow: {
        label: "At Risk",
        colorClass: "text-yellow-400",
        bgClass: "bg-yellow-500/10",
        borderClass: "border-yellow-500/30",
        glowClass: "shadow-yellow-500/20",
        dotColor: "bg-yellow-500",
        glowColor: "rgba(234, 179, 8, 0.4)",
    },
    red: {
        label: "Critical",
        colorClass: "text-red-400",
        bgClass: "bg-red-500/10",
        borderClass: "border-red-500/30",
        glowClass: "shadow-red-500/30",
        dotColor: "bg-red-500",
        glowColor: "rgba(239, 68, 68, 0.5)",
    },
};

const sizeClasses = {
    sm: {
        dot: "h-2 w-2",
        text: "text-xs",
        padding: "px-1.5 py-0.5",
        iconPadding: "p-0.5",
    },
    md: {
        dot: "h-2.5 w-2.5",
        text: "text-sm",
        padding: "px-2 py-1",
        iconPadding: "p-1",
    },
    lg: {
        dot: "h-3 w-3",
        text: "text-base",
        padding: "px-2.5 py-1.5",
        iconPadding: "p-1.5",
    },
};

/**
 * RiskIndicator - Visual badge showing deadline risk level
 *
 * Used on task cards to quickly communicate risk status.
 * Yellow and red indicators pulse to draw attention.
 */
export function RiskIndicator({
    riskLevel,
    size = "sm",
    showLabel = false,
    animate = true,
    className,
    onClick,
}: RiskIndicatorProps) {
    const config = riskConfig[riskLevel];
    const sizes = sizeClasses[size];

    // Don't show indicator for green/on-track tasks
    if (riskLevel === "green") {
        return null;
    }

    const isClickable = !!onClick;
    const Component = isClickable ? "button" : "div";

    return (
        <Component
            onClick={onClick}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full border",
                config.bgClass,
                config.borderClass,
                config.colorClass,
                isClickable && "cursor-pointer hover:brightness-110 transition-all",
                showLabel ? sizes.padding : sizes.iconPadding,
                className
            )}
            title={config.label}
        >
            {/* Pulsing dot indicator */}
            <span className="relative flex items-center justify-center">
                <span
                    className={cn(
                        "rounded-full",
                        sizes.dot,
                        config.dotColor,
                        animate && riskLevel !== "green" && "animate-pulse"
                    )}
                    style={{
                        boxShadow: config.glowColor ? `0 0 12px ${config.glowColor}` : undefined,
                    }}
                />
                {/* Inner ring for critical */}
                {riskLevel === "red" && (
                    <span
                        className={cn(
                            "absolute inset-0 rounded-full border-2 border-red-400",
                            animate && "animate-ping"
                        )}
                        style={{ animationDuration: "1.5s" }}
                    />
                )}
            </span>

            {/* Optional label */}
            {showLabel && <span className={cn("font-medium", config.colorClass, sizes.text)}>{config.label}</span>}
        </Component>
    );
}

/**
 * Compact risk badge for inline use
 */
export function RiskBadge({ riskLevel, className }: { riskLevel: DeadlineRiskLevel; className?: string }) {
    const config = riskConfig[riskLevel];

    if (riskLevel === "green") {
        return null;
    }

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider",
                config.bgClass,
                config.borderClass,
                config.colorClass,
                "border",
                className
            )}
        >
            <span
                className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    riskLevel === "yellow" && "bg-yellow-400",
                    riskLevel === "red" && "bg-red-400 animate-pulse"
                )}
            />
            {config.label}
        </span>
    );
}

/**
 * Risk indicator for task cards with hover effect
 */
export function TaskCardRiskIndicator({
    riskLevel,
    daysLate,
    onClick,
    className,
}: {
    riskLevel: DeadlineRiskLevel;
    daysLate: number;
    onClick?: () => void;
    className?: string;
}) {
    const config = riskConfig[riskLevel];

    if (riskLevel === "green") {
        return null;
    }

    const isClickable = !!onClick;
    const Component = isClickable ? "button" : "div";

    return (
        <Component
            onClick={onClick}
            className={cn(
                "group flex items-center gap-1.5 px-2 py-1 rounded-lg",
                "transition-all duration-200",
                "border",
                config.bgClass,
                config.borderClass,
                isClickable && "cursor-pointer hover:scale-105",
                isClickable && riskLevel === "red" && "hover:shadow-lg hover:shadow-red-500/20",
                isClickable && riskLevel === "yellow" && "hover:shadow-lg hover:shadow-yellow-500/20",
                className
            )}
        >
            {/* Animated dot */}
            <span className="relative">
                <span
                    className={cn(
                        "block h-2 w-2 rounded-full",
                        config.dotColor,
                        riskLevel === "red" && "animate-pulse"
                    )}
                    style={{
                        boxShadow: config.glowColor ? `0 0 8px ${config.glowColor}` : undefined,
                    }}
                />
                {riskLevel === "red" && (
                    <span
                        className="absolute inset-0 rounded-full border border-red-400 animate-ping"
                        style={{ animationDuration: "2s" }}
                    />
                )}
            </span>

            {/* Label */}
            <span className={cn("text-[11px] font-medium", config.colorClass)}>
                {riskLevel === "red" ? "Critical" : "At Risk"}
            </span>

            {/* Days late */}
            {daysLate > 0 && <span className="text-[10px] text-red-400 font-semibold">+{daysLate}d</span>}
        </Component>
    );
}
