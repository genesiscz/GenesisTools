import { cn } from "@ui/lib/utils";
import type React from "react";

type InsightColor = "amber" | "cyan" | "emerald" | "green" | "orange" | "purple" | "red";

const COLOR_CLASSES: Record<InsightColor, string> = {
    amber: "bg-amber-500/10 border-amber-500/20 text-amber-300",
    cyan: "bg-cyan-500/10 border-cyan-500/20 text-cyan-300",
    emerald: "bg-emerald-500/10 border-emerald-500/20 text-emerald-300",
    green: "bg-green-500/10 border-green-500/20 text-green-300",
    orange: "bg-orange-500/10 border-orange-500/20 text-orange-300",
    purple: "bg-purple-500/10 border-purple-500/20 text-purple-300",
    red: "bg-red-500/10 border-red-500/20 text-red-300",
};

interface InsightRowProps {
    icon: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    color: InsightColor;
    className?: string;
}

export function InsightRow({ icon, title, description, color, className }: InsightRowProps) {
    return (
        <div className={cn("flex items-start gap-3 p-3 rounded-lg border", COLOR_CLASSES[color], className)}>
            <span className="mt-0.5 [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
            <div>
                <p className="text-sm font-medium">{title}</p>
                {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
            </div>
        </div>
    );
}

interface InsightCardProps {
    children: React.ReactNode;
    color: InsightColor;
    className?: string;
}

export function InsightCard({ children, color, className }: InsightCardProps) {
    return <div className={cn("p-4 rounded-lg border", COLOR_CLASSES[color], className)}>{children}</div>;
}
