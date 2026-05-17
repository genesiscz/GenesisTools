import { cn } from "@ui/lib/utils";

export type RiskLevel = "green" | "yellow" | "red";

const RISK_CONFIG: Record<
    RiskLevel,
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

interface RiskIndicatorProps {
    level: RiskLevel;
    label?: string;
    onClick?: () => void;
    className?: string;
}

export function RiskIndicator({ level, label, onClick, className }: RiskIndicatorProps) {
    const config = RISK_CONFIG[level];
    const Component = onClick ? "button" : "span";

    return (
        <Component
            type={onClick ? "button" : undefined}
            onClick={onClick}
            className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
                "transition-all duration-200",
                onClick && "cursor-pointer hover:scale-105",
                config.bgClass,
                config.borderClass,
                config.colorClass,
                className
            )}
            style={config.glowColor ? { boxShadow: `0 0 8px ${config.glowColor}` } : undefined}
        >
            <span className="relative flex h-2 w-2">
                {level === "red" && (
                    <span
                        className={cn(
                            "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping",
                            config.dotColor
                        )}
                    />
                )}
                <span
                    className={cn(
                        "relative inline-flex h-2 w-2 rounded-full",
                        config.dotColor,
                        level === "red" && "animate-pulse"
                    )}
                />
            </span>
            {label ?? config.label}
        </Component>
    );
}
