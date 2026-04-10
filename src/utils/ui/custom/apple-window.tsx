import { cn } from "@ui/lib/utils";
import type React from "react";

interface AppleWindowProps {
    /** Title shown in the window's title bar (e.g. "Q3 Roadmap Review") */
    title?: string;
    /** Optional element rendered to the right of the title bar (e.g. a "Recording" tag) */
    rightSlot?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}

/**
 * macOS-style window mockup with red/yellow/green traffic-light buttons.
 * Use for meeting / video / terminal mockups.
 */
export function AppleWindow({ title, rightSlot, children, className }: AppleWindowProps) {
    return (
        <div className={cn("apple-window p-4 sm:p-5", className)}>
            <div className="flex items-center gap-2 mb-4">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <div className="flex-1 text-center">
                    {title && <span className="text-xs text-muted-foreground font-medium">{title}</span>}
                </div>
                {rightSlot}
            </div>
            {children}
        </div>
    );
}
