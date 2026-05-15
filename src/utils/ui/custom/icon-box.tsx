import { cn } from "@ui/lib/utils";
import type React from "react";

interface IconBoxProps {
    icon: React.ReactNode;
    size?: "sm" | "md" | "lg";
    bgClass: string;
    borderClass: string;
    iconClass?: string;
    className?: string;
}

export function IconBox({ icon, size = "md", bgClass, borderClass, iconClass, className }: IconBoxProps) {
    const sizing = size === "sm" ? "w-8 h-8 rounded" : size === "md" ? "w-9 h-9 rounded-lg" : "p-2 rounded-lg";

    return (
        <div className={cn("flex items-center justify-center border", sizing, bgClass, borderClass, className)}>
            <span className={cn("[&_svg]:h-4 [&_svg]:w-4", iconClass)}>{icon}</span>
        </div>
    );
}
