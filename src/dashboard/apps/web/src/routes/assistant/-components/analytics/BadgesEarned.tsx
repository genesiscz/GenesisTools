import { Award, Brain, CheckCircle, Crown, Flame, Rocket, Target, Trophy } from "lucide-react";
import type { BadgeRarity, BadgeType, WeeklyReview } from "@/lib/assistant/types";
import { BADGE_DEFINITIONS } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface BadgesEarnedProps {
    review: WeeklyReview | null;
    loading?: boolean;
}

// Map icon names to components
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    Rocket,
    CheckCircle,
    CheckCircle2: CheckCircle,
    Trophy,
    Flame,
    Crown,
    AlertTriangle: Target,
    ParkingCircle: Target,
    Target,
    Scale: Award,
    MessageSquare: Award,
    Brain,
    Award,
};

/**
 * Grid of badges earned during the week
 */
export function BadgesEarned({ review, loading }: BadgesEarnedProps) {
    if (loading) {
        return <BadgesSkeleton />;
    }

    const badgeTypes = review?.badgesEarned ?? [];

    // Get badge definitions for earned badges
    const earnedBadges = badgeTypes
        .map((badgeType) => BADGE_DEFINITIONS.find((b) => b.type === badgeType))
        .filter(Boolean);

    return (
        <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
            {/* Corner decorations */}
            <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-amber-500/20 rounded-tl" />
            <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-amber-500/20 rounded-tr" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-amber-500/20 rounded-bl" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-amber-500/20 rounded-br" />

            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-semibold">Badges Earned</h3>
                    <p className="text-xs text-muted-foreground">This week's achievements</p>
                </div>
                {earnedBadges.length > 0 && (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        +{earnedBadges.length}
                    </span>
                )}
            </div>

            {/* Badges grid */}
            {earnedBadges.length === 0 ? (
                <div className="text-center py-6">
                    <Award className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">No badges earned this week</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Keep going to unlock achievements!</p>
                </div>
            ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {earnedBadges.map((badge) => (
                        <BadgeCard
                            key={badge?.type}
                            type={badge?.type}
                            displayName={badge?.displayName}
                            description={badge?.description}
                            iconName={badge?.icon}
                            rarity={badge?.rarity}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface BadgeCardProps {
    type: BadgeType;
    displayName: string;
    description: string;
    iconName: string;
    rarity: BadgeRarity;
}

function BadgeCard({ displayName, description, iconName, rarity }: BadgeCardProps) {
    const Icon = iconMap[iconName] ?? Award;
    const rarityColors = getRarityColors(rarity);

    return (
        <div
            className={cn(
                "relative p-3 rounded-lg border transition-all hover:scale-105",
                rarityColors.bg,
                rarityColors.border
            )}
        >
            {/* Rarity glow effect for rare+ badges */}
            {(rarity === "rare" || rarity === "legendary") && (
                <div
                    className={cn(
                        "absolute inset-0 rounded-lg opacity-20 blur-xl -z-10",
                        rarity === "rare" && "bg-purple-500",
                        rarity === "legendary" && "bg-amber-500"
                    )}
                />
            )}

            <div className="flex flex-col items-center text-center">
                <div className={cn("p-2 rounded-lg mb-2", rarityColors.iconBg)}>
                    <Icon className={cn("h-5 w-5", rarityColors.text)} />
                </div>
                <p className={cn("text-xs font-semibold", rarityColors.text)}>{displayName}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{description}</p>
                <span
                    className={cn(
                        "text-[8px] uppercase tracking-wider mt-2 px-1.5 py-0.5 rounded-full",
                        rarityColors.rarityBg,
                        rarityColors.text
                    )}
                >
                    {rarity}
                </span>
            </div>
        </div>
    );
}

function getRarityColors(rarity: BadgeRarity): {
    bg: string;
    border: string;
    text: string;
    iconBg: string;
    rarityBg: string;
} {
    switch (rarity) {
        case "common":
            return {
                bg: "bg-gray-500/5",
                border: "border-gray-500/20",
                text: "text-gray-400",
                iconBg: "bg-gray-500/10",
                rarityBg: "bg-gray-500/10",
            };
        case "uncommon":
            return {
                bg: "bg-emerald-500/5",
                border: "border-emerald-500/20",
                text: "text-emerald-400",
                iconBg: "bg-emerald-500/10",
                rarityBg: "bg-emerald-500/10",
            };
        case "rare":
            return {
                bg: "bg-purple-500/5",
                border: "border-purple-500/20",
                text: "text-purple-400",
                iconBg: "bg-purple-500/10",
                rarityBg: "bg-purple-500/10",
            };
        case "legendary":
            return {
                bg: "bg-amber-500/5",
                border: "border-amber-500/20",
                text: "text-amber-400",
                iconBg: "bg-amber-500/10",
                rarityBg: "bg-amber-500/10",
            };
    }
}

function BadgesSkeleton() {
    return (
        <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <div className="h-4 w-28 bg-white/5 rounded animate-pulse mb-1" />
                    <div className="h-3 w-36 bg-white/5 rounded animate-pulse" />
                </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="p-3 rounded-lg border border-white/5 bg-white/5">
                        <div className="flex flex-col items-center">
                            <div className="h-9 w-9 rounded-lg bg-white/5 animate-pulse mb-2" />
                            <div className="h-3 w-16 bg-white/5 rounded animate-pulse mb-1" />
                            <div className="h-2 w-20 bg-white/5 rounded animate-pulse" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
