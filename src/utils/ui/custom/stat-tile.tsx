import { cn } from "@ui/lib/utils";
import type React from "react";

interface StatTileProps {
    icon: React.ReactNode;
    label: React.ReactNode;
    value: React.ReactNode;
    valueColor?: string;
    className?: string;
}

export function StatTile({ icon, label, value, valueColor = "text-foreground", className }: StatTileProps) {
    return (
        <div className={cn("p-3 rounded-lg bg-white/5 border border-white/10", className)}>
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <span className="[&_svg]:h-4 [&_svg]:w-4">{icon}</span>
                <span className="text-xs">{label}</span>
            </div>
            <p className={cn("text-lg font-semibold", valueColor)}>{value}</p>
        </div>
    );
}
