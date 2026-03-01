/**
 * MicroCelebration - Tier 1 toast notification
 *
 * Non-intrusive celebration toast that appears in the bottom-right corner.
 * Auto-dismisses after 3 seconds.
 *
 * Used for:
 * - Focus session complete (25 min)
 * - Small task complete (nice-to-have urgency)
 * - 3-task day milestone
 */

import { Check, Flame, Star, Target, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { MicroCelebrationData } from "./types";
import { CELEBRATION_DURATION } from "./types";

interface MicroCelebrationProps {
    celebration: MicroCelebrationData;
    onDismiss: () => void;
}

const ICONS = {
    check: Check,
    focus: Target,
    flame: Flame,
    star: Star,
    zap: Zap,
} as const;

const ACCENT_STYLES = {
    emerald: {
        border: "border-emerald-500/50",
        glow: "shadow-[0_0_15px_rgba(16,185,129,0.3)]",
        icon: "text-emerald-400",
        gradient: "from-emerald-500/20 to-transparent",
    },
    amber: {
        border: "border-amber-500/50",
        glow: "shadow-[0_0_15px_rgba(245,158,11,0.3)]",
        icon: "text-amber-400",
        gradient: "from-amber-500/20 to-transparent",
    },
    purple: {
        border: "border-purple-500/50",
        glow: "shadow-[0_0_15px_rgba(168,85,247,0.3)]",
        icon: "text-purple-400",
        gradient: "from-purple-500/20 to-transparent",
    },
    blue: {
        border: "border-blue-500/50",
        glow: "shadow-[0_0_15px_rgba(59,130,246,0.3)]",
        icon: "text-blue-400",
        gradient: "from-blue-500/20 to-transparent",
    },
} as const;

export function MicroCelebration({ celebration, onDismiss }: MicroCelebrationProps) {
    const [isVisible, setIsVisible] = useState(false);
    const [isExiting, setIsExiting] = useState(false);

    const IconComponent = ICONS[celebration.icon ?? "check"];
    const accent = ACCENT_STYLES[celebration.accent ?? "emerald"];

    // Animate in on mount
    useEffect(() => {
        // Small delay for mount animation
        const showTimer = setTimeout(() => setIsVisible(true), 50);

        // Auto-dismiss after duration
        const dismissTimer = setTimeout(() => {
            setIsExiting(true);
            setTimeout(onDismiss, 300); // Wait for exit animation
        }, CELEBRATION_DURATION.micro);

        return () => {
            clearTimeout(showTimer);
            clearTimeout(dismissTimer);
        };
    }, [onDismiss]);

    // Handle manual dismiss
    function handleDismiss() {
        setIsExiting(true);
        setTimeout(onDismiss, 300);
    }

    const content = (
        <div
            className={cn(
                "fixed bottom-6 right-6 z-[100]",
                "max-w-xs w-full",
                "transform transition-all duration-300 ease-out",
                isVisible && !isExiting ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"
            )}
            role="alert"
            aria-live="polite"
        >
            <div
                className={cn(
                    "relative overflow-hidden",
                    "bg-card/95 backdrop-blur-md",
                    "rounded-xl border-2",
                    accent.border,
                    accent.glow,
                    "p-4",
                    "flex items-start gap-3"
                )}
            >
                {/* Gradient overlay */}
                <div className={cn("absolute inset-0 bg-gradient-to-r", accent.gradient, "pointer-events-none")} />

                {/* Icon */}
                <div
                    className={cn(
                        "relative flex-shrink-0",
                        "w-10 h-10 rounded-full",
                        "bg-black/20 border border-white/10",
                        "flex items-center justify-center",
                        "animate-pulse"
                    )}
                >
                    <IconComponent className={cn("h-5 w-5", accent.icon)} />
                </div>

                {/* Content */}
                <div className="relative flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-foreground mb-0.5">{celebration.title}</h4>
                    <p className="text-xs text-muted-foreground line-clamp-2">{celebration.message}</p>
                </div>

                {/* Dismiss button */}
                <button
                    onClick={handleDismiss}
                    className={cn(
                        "relative flex-shrink-0",
                        "p-1 rounded-full",
                        "text-muted-foreground hover:text-foreground",
                        "hover:bg-white/10",
                        "transition-colors"
                    )}
                    aria-label="Dismiss"
                >
                    <X className="h-4 w-4" />
                </button>

                {/* Progress bar */}
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/20">
                    <div
                        className={cn(
                            "h-full",
                            celebration.accent === "emerald" && "bg-emerald-500",
                            celebration.accent === "amber" && "bg-amber-500",
                            celebration.accent === "purple" && "bg-purple-500",
                            celebration.accent === "blue" && "bg-blue-500",
                            !celebration.accent && "bg-emerald-500"
                        )}
                        style={{
                            animation: `shrink-width ${CELEBRATION_DURATION.micro}ms linear forwards`,
                        }}
                    />
                </div>
            </div>

            {/* Inline styles for animation */}
            <style>{`
        @keyframes shrink-width {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
        </div>
    );

    // Portal to document body for proper positioning
    if (typeof document === "undefined") {
        return null;
    }
    return createPortal(content, document.body);
}

/**
 * Hook to manage micro celebrations
 */
export function useMicroCelebrations() {
    const [celebrations, setCelebrations] = useState<MicroCelebrationData[]>([]);

    function showCelebration(data: Omit<MicroCelebrationData, "id" | "tier">) {
        const celebration: MicroCelebrationData = {
            ...data,
            id: `micro_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            tier: "micro",
        };
        setCelebrations((prev) => [...prev, celebration]);
    }

    function dismissCelebration(id: string) {
        setCelebrations((prev) => prev.filter((c) => c.id !== id));
    }

    return {
        celebrations,
        showCelebration,
        dismissCelebration,
    };
}
