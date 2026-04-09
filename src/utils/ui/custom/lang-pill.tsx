import { cn } from "@ui/lib/utils";
import type React from "react";

interface LangPillProps {
    children: React.ReactNode;
    active?: boolean;
    onClick?: () => void;
    className?: string;
}

export function LangPill({ children, active = false, onClick, className }: LangPillProps) {
    const Comp = onClick ? "button" : "span";

    return (
        <Comp
            type={onClick ? "button" : undefined}
            onClick={onClick}
            className={cn("lang-pill", active && "lang-pill-active", className)}
        >
            {children}
        </Comp>
    );
}
