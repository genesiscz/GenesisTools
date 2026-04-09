import { Card } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import type React from "react";

interface StatCardProps {
    value: string | number;
    label: string;
    trend?: string;
    trendPositive?: boolean;
    icon?: React.ReactNode;
    className?: string;
}

export function StatCard({ value, label, trend, trendPositive = true, icon, className }: StatCardProps) {
    return (
        <Card variant="wow-static" className={cn("rounded-[14px] p-4 gap-0", className)}>
            {icon && <div className="mb-3 text-muted-foreground">{icon}</div>}
            <div className="text-2xl font-bold text-foreground mb-1">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
            {trend && (
                <div className={cn("mt-2 text-xs font-medium", trendPositive ? "text-emerald-500" : "text-red-400")}>
                    {trend}
                </div>
            )}
        </Card>
    );
}
