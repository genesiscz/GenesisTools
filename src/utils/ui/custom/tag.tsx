import { cn } from "@ui/lib/utils";
import type React from "react";

export type TagColor = "emerald" | "cyan" | "orange" | "purple" | "pink" | "blue" | "red";

interface TagProps {
    children: React.ReactNode;
    color?: TagColor;
    className?: string;
}

export function Tag({ children, color = "purple", className }: TagProps) {
    return <span className={cn("tag", `tag-${color}`, className)}>{children}</span>;
}
