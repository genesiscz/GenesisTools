import * as Icons from "lucide-react";
import type { BadgeProgress as BadgeProgressType, BadgeRarity } from "@/lib/assistant/types";
import { BADGE_DEFINITIONS } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface BadgeProgressProps {
    /** List of badge progress items */
    progressList: BadgeProgressType[];
    /** Maximum items to show */
    maxItems?: number;
    /** Loading state */
    loading?: boolean;
    /** Show only badges above this percent */
    minPercent?: number;
    /** Additional class names */
    className?: string;
}

/**
 * Rarity color configuration for progress bars
 */
const rarityProgressConfig: Record<
    BadgeRarity,
    {
        barColor: string;
        bgColor: string;
        textColor: string;
        glowStyle: string;
    }
> = {
    common: {
        barColor: "bg-gray-400",
        bgColor: "bg-gray-800/50",
        textColor: "text-gray-400",
        glowStyle: "",
    },
    uncommon: {
        barColor: "bg-green-400",
        bgColor: "bg-green-900/20",
        textColor: "text-green-400",
        glowStyle: "0 0 10px rgba(74, 222, 128, 0.3)",
    },
    rare: {
        barColor: "bg-purple-400",
        bgColor: "bg-purple-900/20",
        textColor: "text-purple-400",
        glowStyle: "0 0 10px rgba(192, 132, 252, 0.3)",
    },
    legendary: {
        barColor: "bg-amber-400",
        bgColor: "bg-amber-900/20",
        textColor: "text-amber-400",
        glowStyle: "0 0 15px rgba(251, 191, 36, 0.4)",
    },
};

/**
 * Get Lucide icon component by name
 */
function getIconComponent(iconName: string): Icons.LucideIcon {
    const icon = (Icons as Record<string, Icons.LucideIcon>)[iconName];
    return icon ?? Icons.Award;
}

/**
 * Single progress bar item
 */
function BadgeProgressItem({ progress, className }: { progress: BadgeProgressType; className?: string }) {
    const definition = BADGE_DEFINITIONS.find((b) => b.type === progress.badgeType);
    if (!definition) {
        return null;
    }

    const config = rarityProgressConfig[progress.rarity];
    const IconComponent = getIconComponent(definition.icon);
    const percent = Math.min(100, Math.max(0, progress.percentComplete));
    const isAlmostComplete = percent >= 75;
    const isCloseToComplete = percent >= 90;

    return (
        <div
            className={cn(
                "group relative p-4 rounded-lg border transition-all duration-300",
                "bg-[#0a0a14]/60 hover:bg-[#0a0a14]/80",
                "border-gray-800/50 hover:border-gray-700/50",
                isAlmostComplete && "border-opacity-75",
                className
            )}
        >
            {/* Background glow for high progress */}
            {isAlmostComplete && (
                <div
                    className={cn("absolute inset-0 rounded-lg opacity-20 blur-xl transition-opacity", config.barColor)}
                    style={{ opacity: (percent - 75) / 100 }}
                />
            )}

            <div className="relative flex items-start gap-3">
                {/* Icon */}
                <div
                    className={cn(
                        "flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center",
                        "border transition-all",
                        config.bgColor,
                        isAlmostComplete ? `${config.textColor.replace("text-", "border-")}/40` : "border-gray-700/30"
                    )}
                >
                    <IconComponent className={cn("h-5 w-5", config.textColor)} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    {/* Header */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium text-sm truncate">{progress.displayName}</span>
                        <span className={cn("text-xs font-mono", config.textColor)}>{Math.round(percent)}%</span>
                    </div>

                    {/* Description */}
                    <p className="text-xs text-muted-foreground mb-2 line-clamp-1">{progress.description}</p>

                    {/* Progress bar */}
                    <div className="relative">
                        <div className={cn("h-2 rounded-full overflow-hidden", config.bgColor)}>
                            <div
                                className={cn(
                                    "h-full rounded-full transition-all duration-500 ease-out",
                                    config.barColor,
                                    isCloseToComplete && "animate-pulse"
                                )}
                                style={{
                                    width: `${percent}%`,
                                    boxShadow: percent > 25 ? config.glowStyle : undefined,
                                }}
                            />
                        </div>

                        {/* Milestone markers at 25%, 50%, 75% */}
                        <div className="absolute inset-0 flex justify-between px-[1px]">
                            {[25, 50, 75].map((milestone) => (
                                <div
                                    key={milestone}
                                    className={cn("w-px h-2", percent >= milestone ? "bg-white/20" : "bg-gray-700/50")}
                                    style={{ marginLeft: `${milestone}%` }}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Progress text */}
                    <div className="flex items-center justify-between mt-1.5 text-[10px]">
                        <span className="text-muted-foreground">
                            {progress.current}/{progress.target}
                        </span>
                        <span className={cn("uppercase tracking-wider", config.textColor)}>{progress.rarity}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * BadgeProgress - Display progress toward unearned badges
 *
 * Features:
 * - Neon-styled progress bars by rarity
 * - Sorted by completion percentage
 * - Milestone markers
 * - Pulse animation when close to completion
 */
export function BadgeProgress({
    progressList,
    maxItems = 5,
    loading = false,
    minPercent = 0,
    className,
}: BadgeProgressProps) {
    // Filter and sort by progress
    const displayProgress = progressList
        .filter((p) => p.percentComplete >= minPercent && p.percentComplete < 100)
        .sort((a, b) => b.percentComplete - a.percentComplete)
        .slice(0, maxItems);

    // Loading skeleton
    if (loading) {
        return (
            <div className={cn("space-y-4", className)}>
                <div className="flex items-center gap-2 animate-pulse">
                    <div className="w-5 h-5 rounded bg-gray-700" />
                    <div className="w-32 h-5 rounded bg-gray-700" />
                </div>
                <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div
                            key={i}
                            className="h-24 rounded-lg bg-gray-800/50 animate-pulse"
                            style={{ animationDelay: `${i * 100}ms` }}
                        />
                    ))}
                </div>
            </div>
        );
    }

    // Empty state
    if (displayProgress.length === 0) {
        return (
            <div className={cn("flex flex-col items-center justify-center py-8", className)}>
                <Icons.Sparkles className="h-8 w-8 text-gray-600 mb-3" />
                <p className="text-sm text-muted-foreground text-center">All badges earned or no progress yet!</p>
            </div>
        );
    }

    return (
        <div className={cn("space-y-4", className)}>
            {/* Header */}
            <div className="flex items-center gap-2">
                <Icons.TrendingUp className="h-5 w-5 text-cyan-400" />
                <h3 className="text-lg font-semibold">In Progress</h3>
            </div>

            {/* Progress list */}
            <div className="space-y-3">
                {displayProgress.map((progress) => (
                    <BadgeProgressItem key={progress.badgeType} progress={progress} />
                ))}
            </div>
        </div>
    );
}

/**
 * BadgeProgressCompact - Single line progress display
 */
export function BadgeProgressCompact({ progress, className }: { progress: BadgeProgressType; className?: string }) {
    const config = rarityProgressConfig[progress.rarity];
    const percent = Math.min(100, Math.max(0, progress.percentComplete));

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <div className={cn("flex-1 h-1.5 rounded-full overflow-hidden", config.bgColor)}>
                <div className={cn("h-full rounded-full", config.barColor)} style={{ width: `${percent}%` }} />
            </div>
            <span className={cn("text-xs font-mono min-w-[3ch]", config.textColor)}>{Math.round(percent)}%</span>
        </div>
    );
}

/**
 * NextBadgePreview - Highlight the closest badge to completion
 */
export function NextBadgePreview({ progress, className }: { progress: BadgeProgressType | null; className?: string }) {
    if (!progress) {
        return null;
    }

    const definition = BADGE_DEFINITIONS.find((b) => b.type === progress.badgeType);
    if (!definition) {
        return null;
    }

    const config = rarityProgressConfig[progress.rarity];
    const IconComponent = getIconComponent(definition.icon);
    const percent = Math.min(100, progress.percentComplete);
    const remaining = progress.target - progress.current;

    return (
        <div
            className={cn(
                "p-4 rounded-xl border",
                "bg-gradient-to-br from-gray-900/80 to-gray-900/40",
                "border-gray-800/50",
                className
            )}
        >
            <div className="flex items-center gap-3 mb-3">
                <div
                    className={cn(
                        "w-12 h-12 rounded-xl flex items-center justify-center",
                        "border",
                        config.bgColor,
                        `${config.textColor.replace("text-", "border-")}/30`
                    )}
                >
                    <IconComponent className={cn("h-6 w-6", config.textColor)} />
                </div>
                <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Next Badge</p>
                    <p className="font-semibold">{progress.displayName}</p>
                </div>
            </div>

            {/* Progress bar */}
            <div className="mb-2">
                <div className={cn("h-2 rounded-full overflow-hidden", config.bgColor)}>
                    <div
                        className={cn("h-full rounded-full", config.barColor)}
                        style={{
                            width: `${percent}%`,
                            boxShadow: config.glowStyle,
                        }}
                    />
                </div>
            </div>

            <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                    {progress.current}/{progress.target}
                </span>
                <span className={config.textColor}>{remaining} more to go</span>
            </div>
        </div>
    );
}
