import { cn } from "@ui/lib/utils";
import type React from "react";

interface TagChipProps {
    children: React.ReactNode;
    onRemove?: () => void;
    className?: string;
}

export function TagChip({ children, onRemove, className }: TagChipProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground",
                className
            )}
        >
            {children}
            {onRemove && (
                <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-foreground">
                    <span className="sr-only">Remove tag</span>x
                </button>
            )}
        </span>
    );
}
