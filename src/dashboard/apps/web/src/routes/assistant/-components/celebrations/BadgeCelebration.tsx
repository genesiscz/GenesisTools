/**
 * BadgeCelebration - Tier 2 badge notification
 *
 * Center-positioned celebration for significant achievements.
 * Persists for 5 seconds, click to dismiss.
 *
 * Used for:
 * - 5-day streak
 * - 10 tasks completed
 * - Speedrunner (5 tasks in one day)
 */

import { Flame, Sparkles, Trophy, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BadgeRarity } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";
import {
    createParticles,
    type Particle,
    type ParticleColorScheme,
    renderParticles,
    updateParticles,
} from "./particles";
import type { BadgeCelebrationData } from "./types";
import { CELEBRATION_DURATION } from "./types";

interface BadgeCelebrationProps {
    celebration: BadgeCelebrationData;
    onDismiss: () => void;
    particlesEnabled?: boolean;
}

const RARITY_STYLES: Record<
    BadgeRarity,
    {
        border: string;
        glow: string;
        text: string;
        bg: string;
        particles: ParticleColorScheme;
    }
> = {
    common: {
        border: "border-gray-400/50",
        glow: "shadow-[0_0_20px_rgba(156,163,175,0.4)]",
        text: "text-gray-300",
        bg: "bg-gray-500/20",
        particles: "mixed",
    },
    uncommon: {
        border: "border-emerald-400/50",
        glow: "shadow-[0_0_25px_rgba(52,211,153,0.4)]",
        text: "text-emerald-400",
        bg: "bg-emerald-500/20",
        particles: "emerald",
    },
    rare: {
        border: "border-purple-400/50",
        glow: "shadow-[0_0_30px_rgba(192,132,252,0.5)]",
        text: "text-purple-400",
        bg: "bg-purple-500/20",
        particles: "purple",
    },
    legendary: {
        border: "border-amber-400/50",
        glow: "shadow-[0_0_40px_rgba(251,191,36,0.6)]",
        text: "text-amber-400",
        bg: "bg-amber-500/20",
        particles: "amber",
    },
};

export function BadgeCelebration({ celebration, onDismiss, particlesEnabled = true }: BadgeCelebrationProps) {
    const [isVisible, setIsVisible] = useState(false);
    const [isExiting, setIsExiting] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const particlesRef = useRef<Particle[]>([]);
    const animationRef = useRef<number | null>(null);

    const rarity = celebration.badgeRarity ?? "uncommon";
    const styles = RARITY_STYLES[rarity];

    // Get appropriate icon based on trigger
    function getIcon() {
        if (celebration.trigger === "streak-milestone") {
            return Flame;
        }
        if (celebration.trigger === "speedrunner") {
            return Zap;
        }
        return Trophy;
    }

    const IconComponent = getIcon();

    // Animate in on mount
    useEffect(() => {
        const showTimer = setTimeout(() => setIsVisible(true), 50);

        const dismissTimer = setTimeout(() => {
            setIsExiting(true);
            setTimeout(onDismiss, 400);
        }, CELEBRATION_DURATION.badge);

        return () => {
            clearTimeout(showTimer);
            clearTimeout(dismissTimer);
        };
    }, [onDismiss]);

    // Particle animation
    useEffect(() => {
        if (!particlesEnabled || !canvasRef.current) {
            return;
        }

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return;
        }

        // Set canvas size to match viewport
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Create initial particles from center
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        particlesRef.current = createParticles(40, centerX, centerY, styles.particles);

        function animate() {
            if (!ctx || !canvas) {
                return;
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            particlesRef.current = updateParticles(particlesRef.current);
            renderParticles(ctx, particlesRef.current);

            if (particlesRef.current.length > 0) {
                animationRef.current = requestAnimationFrame(animate);
            }
        }

        animate();

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [particlesEnabled, styles.particles]);

    function handleDismiss() {
        setIsExiting(true);
        setTimeout(onDismiss, 400);
    }

    const content = (
        <>
            {/* Particle canvas */}
            {particlesEnabled && (
                <canvas
                    ref={canvasRef}
                    className="fixed inset-0 pointer-events-none z-[99]"
                    style={{ width: "100vw", height: "100vh" }}
                />
            )}

            {/* Backdrop */}
            <div
                className={cn(
                    "fixed inset-0 z-[100]",
                    "bg-black/40 backdrop-blur-sm",
                    "transition-opacity duration-300",
                    isVisible && !isExiting ? "opacity-100" : "opacity-0"
                )}
                onClick={handleDismiss}
            />

            {/* Celebration card */}
            <div
                className={cn(
                    "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101]",
                    "w-full max-w-sm",
                    "transform transition-all duration-400 ease-out",
                    isVisible && !isExiting ? "scale-100 opacity-100" : "scale-90 opacity-0"
                )}
                role="alertdialog"
                aria-labelledby="badge-celebration-title"
                aria-describedby="badge-celebration-message"
            >
                <div
                    className={cn(
                        "relative overflow-hidden",
                        "bg-card/95 backdrop-blur-md",
                        "rounded-2xl border-2",
                        styles.border,
                        styles.glow,
                        "p-6 text-center"
                    )}
                >
                    {/* Background gradient */}
                    <div
                        className={cn(
                            "absolute inset-0",
                            "bg-gradient-to-b from-white/5 to-transparent",
                            "pointer-events-none"
                        )}
                    />

                    {/* Close button */}
                    <button
                        onClick={handleDismiss}
                        className={cn(
                            "absolute top-3 right-3",
                            "p-1.5 rounded-full",
                            "text-muted-foreground hover:text-foreground",
                            "hover:bg-white/10",
                            "transition-colors"
                        )}
                        aria-label="Dismiss"
                    >
                        <X className="h-4 w-4" />
                    </button>

                    {/* Icon with glow effect */}
                    <div className="relative mb-4">
                        <div
                            className={cn(
                                "w-20 h-20 mx-auto rounded-full",
                                styles.bg,
                                "border-2",
                                styles.border,
                                "flex items-center justify-center",
                                "animate-[pulse_2s_ease-in-out_infinite]"
                            )}
                        >
                            <IconComponent className={cn("h-10 w-10", styles.text)} />
                        </div>
                        <Sparkles className={cn("absolute -top-1 -right-1 h-6 w-6", styles.text, "animate-pulse")} />
                        <Sparkles
                            className={cn(
                                "absolute -bottom-1 -left-1 h-5 w-5",
                                styles.text,
                                "animate-pulse",
                                "delay-150"
                            )}
                        />
                    </div>

                    {/* Title */}
                    <h3 id="badge-celebration-title" className={cn("text-xl font-bold mb-2", styles.text)}>
                        {celebration.title}
                    </h3>

                    {/* Badge name if applicable */}
                    {celebration.badgeName && (
                        <div
                            className={cn(
                                "inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-3",
                                styles.bg,
                                "border",
                                styles.border
                            )}
                        >
                            <Trophy className={cn("h-4 w-4", styles.text)} />
                            <span className={cn("text-sm font-semibold", styles.text)}>{celebration.badgeName}</span>
                        </div>
                    )}

                    {/* Streak indicator if applicable */}
                    {celebration.streakDays && (
                        <div
                            className={cn(
                                "inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-3",
                                "bg-orange-500/20 border border-orange-500/30"
                            )}
                        >
                            <Flame className="h-4 w-4 text-orange-400" />
                            <span className="text-sm font-semibold text-orange-400">
                                {celebration.streakDays}-day streak
                            </span>
                        </div>
                    )}

                    {/* Tasks count if applicable */}
                    {celebration.tasksCompleted && (
                        <div
                            className={cn(
                                "inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-3",
                                "bg-purple-500/20 border border-purple-500/30"
                            )}
                        >
                            <Trophy className="h-4 w-4 text-purple-400" />
                            <span className="text-sm font-semibold text-purple-400">
                                {celebration.tasksCompleted} tasks completed
                            </span>
                        </div>
                    )}

                    {/* Message */}
                    <p id="badge-celebration-message" className="text-sm text-muted-foreground mt-3">
                        {celebration.message}
                    </p>

                    {/* Rarity badge */}
                    <div className="mt-4">
                        <span
                            className={cn(
                                "inline-block text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded",
                                styles.bg,
                                styles.text
                            )}
                        >
                            {rarity}
                        </span>
                    </div>

                    {/* Progress bar */}
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20">
                        <div
                            className={cn(
                                "h-full",
                                rarity === "legendary" && "bg-amber-500",
                                rarity === "rare" && "bg-purple-500",
                                rarity === "uncommon" && "bg-emerald-500",
                                rarity === "common" && "bg-gray-400"
                            )}
                            style={{
                                animation: `shrink-width ${CELEBRATION_DURATION.badge}ms linear forwards`,
                            }}
                        />
                    </div>
                </div>

                <style>{`
          @keyframes shrink-width {
            from { width: 100%; }
            to { width: 0%; }
          }
        `}</style>
            </div>
        </>
    );

    if (typeof document === "undefined") {
        return null;
    }
    return createPortal(content, document.body);
}

/**
 * Hook to manage badge celebrations
 */
export function useBadgeCelebrations() {
    const [celebration, setCelebration] = useState<BadgeCelebrationData | null>(null);

    function showCelebration(data: Omit<BadgeCelebrationData, "id" | "tier">) {
        const celebrationData: BadgeCelebrationData = {
            ...data,
            id: `badge_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            tier: "badge",
        };
        setCelebration(celebrationData);
    }

    function dismissCelebration() {
        setCelebration(null);
    }

    return {
        celebration,
        showCelebration,
        dismissCelebration,
    };
}
