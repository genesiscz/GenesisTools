import { cn } from "@ui/lib/utils";
import type React from "react";

interface AnimatedCardProps {
    index: number;
    stagger?: number;
    variant?: "fade-in-up" | "slide-up";
    children: React.ReactNode;
    className?: string;
}

export function AnimatedCard({ index, stagger = 50, variant = "fade-in-up", children, className }: AnimatedCardProps) {
    const animation = variant === "fade-in-up" ? "animate-fade-in-up" : "animate-slide-up";

    return (
        <div className={cn(animation, "h-full", className)} style={{ animationDelay: `${index * stagger}ms` }}>
            {children}
        </div>
    );
}
