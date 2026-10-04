import { Card } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type React from "react";

interface StatCardProps {
    value: string | number;
    label: string;
    trend?: string;
    trendPositive?: boolean;
    icon?: React.ReactNode;
    /** The page's key number. One per screen; themed dashboards render it as the highlighted card. */
    featured?: boolean;
    className?: string;
}

/** `data-stat*` hooks let the dashboard themes (`@ui/theme/surfaces.css`) lay the card out as icon + label, number, hint. */
export function StatCard({ value, label, trend, trendPositive = true, icon, featured, className }: StatCardProps) {
    return (
        <Card
            variant="wow-static"
            data-stat-card=""
            data-featured={featured ? "" : undefined}
            className={cn("rounded-[14px] p-4 gap-0", className)}
        >
            {icon && (
                <div data-stat="icon" className="mb-3 text-muted-foreground">
                    {icon}
                </div>
            )}
            <div data-stat="value" className="text-2xl font-bold text-foreground mb-1">
                {value}
            </div>
            <div data-stat="label" className="text-xs text-muted-foreground">
                {label}
            </div>
            {trend && (
                <div
                    data-stat="hint"
                    data-trend={trendPositive ? "up" : "down"}
                    className={cn("mt-2 text-xs font-medium", trendPositive ? "text-emerald-500" : "text-red-400")}
                >
                    {trend}
                </div>
            )}
        </Card>
    );
}

const statCardNexusColors = {
    accent: {
        wrap: "bg-accent/10 border-accent/30",
        iconBox: "bg-accent/20",
        icon: "text-accent",
        value: "text-accent",
    },
    primary: {
        wrap: "bg-primary/10 border-primary/30",
        iconBox: "bg-primary/20",
        icon: "text-primary",
        value: "text-primary",
    },
} as const;

export type StatCardNexusColor = keyof typeof statCardNexusColors;

interface StatCardNexusProps {
    icon: React.ReactNode;
    value: string;
    label: string;
    color: StatCardNexusColor;
    className?: string;
}

export function StatCardNexus({ icon, value, label, color, className }: StatCardNexusProps) {
    const c = statCardNexusColors[color];

    return (
        <div className={cn("flex items-center gap-3 p-3 rounded-lg border backdrop-blur-sm", c.wrap, className)}>
            <div className={cn("p-2 rounded-lg", c.iconBox)}>
                <span className={cn("[&_svg]:h-4 [&_svg]:w-4", c.icon)}>{icon}</span>
            </div>
            <div>
                <div className={cn("text-2xl font-mono font-bold", c.value)}>{value}</div>
                <div className="text-[10px] text-foreground/60 first-letter:uppercase font-medium">{label}</div>
            </div>
        </div>
    );
}

export { statCardNexusColors };
