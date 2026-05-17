import { cn } from "@ui/lib/utils";
import type React from "react";

interface StatusBadgeProps {
    children: React.ReactNode;
    bgClass: string;
    textClass: string;
    borderClass?: string;
    shape?: "flat" | "pill";
    size?: "xs" | "sm";
    uppercase?: boolean;
    icon?: React.ReactNode;
    className?: string;
}

export function StatusBadge({
    children,
    bgClass,
    textClass,
    borderClass,
    shape = "pill",
    size = "sm",
    uppercase = true,
    icon,
    className,
}: StatusBadgeProps) {
    const rounded = shape === "pill" ? "rounded-full" : "rounded";
    const sizing = size === "xs" ? "text-[10px] px-1.5 py-0.5" : "text-[10px] font-semibold px-2 py-0.5";

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5",
                borderClass && "border",
                sizing,
                rounded,
                uppercase && "uppercase tracking-wide",
                bgClass,
                textClass,
                borderClass,
                className
            )}
        >
            {icon}
            {children}
        </span>
    );
}
