import { cn } from "@ui/lib/utils";
import type React from "react";

export type IconContainerVariant = "purple" | "red" | "orange" | "blue" | "cyan" | "emerald" | "pink" | "violet";

interface IconContainerProps {
    icon: React.ReactNode;
    variant?: IconContainerVariant;
    className?: string;
}

export function IconContainer({ icon, variant = "purple", className }: IconContainerProps) {
    return <div className={cn("icon-container", `icon-container-${variant}`, className)}>{icon}</div>;
}
