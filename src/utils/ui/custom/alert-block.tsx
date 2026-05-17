import { cn } from "@ui/lib/utils";
import type React from "react";

type AlertColor = "amber" | "cyan" | "emerald" | "purple" | "rose";

const PALETTE: Record<AlertColor, string> = {
    amber: "bg-amber-500/10 border-amber-500/20",
    cyan: "bg-cyan-500/10 border-cyan-500/20",
    emerald: "bg-emerald-500/10 border-emerald-500/20",
    purple: "bg-purple-500/10 border-purple-500/20",
    rose: "bg-rose-500/10 border-rose-500/20",
};

interface AlertBlockProps {
    color: AlertColor;
    children: React.ReactNode;
    size?: "sm" | "md";
    className?: string;
}

export function AlertBlock({ color, children, size = "sm", className }: AlertBlockProps) {
    const padding = size === "sm" ? "p-3" : "p-4";

    return <div className={cn("rounded-lg border", padding, PALETTE[color], className)}>{children}</div>;
}
