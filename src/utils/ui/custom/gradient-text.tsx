import { cn } from "@ui/lib/utils";
import type React from "react";

const gradients = {
    violetPink: "from-violet-400 via-purple-400 to-pink-400",
    blueCyan: "from-blue-400 to-cyan-400",
    orangeRose: "from-orange-400 to-rose-400",
    emeraldCyan: "from-emerald-400 to-cyan-400",
};

type GradientKey = keyof typeof gradients;

interface GradientTextProps {
    children: React.ReactNode;
    gradient?: GradientKey;
    className?: string;
}

export function GradientText({ children, gradient = "violetPink", className }: GradientTextProps) {
    return (
        <span className={cn("bg-gradient-to-r bg-clip-text text-transparent", gradients[gradient], className)}>
            {children}
        </span>
    );
}
