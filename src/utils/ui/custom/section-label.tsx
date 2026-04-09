import { cn } from "@ui/lib/utils";
import type React from "react";

type SectionLabelColor = "emerald" | "cyan" | "orange" | "blue" | "purple" | "violet" | "rose";

interface SectionLabelProps {
    children: React.ReactNode;
    color?: SectionLabelColor;
    className?: string;
}

export function SectionLabel({ children, color = "emerald", className }: SectionLabelProps) {
    return <p className={cn("section-label", `section-label-${color}`, className)}>{children}</p>;
}
