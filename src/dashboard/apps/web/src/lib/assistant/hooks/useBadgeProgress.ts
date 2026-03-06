/**
 * Badge Progress Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for caching computed badge progress.
 * Badge progress is derived from tasks, streaks, badges, and other data.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { initializeAssistantStorage } from "@/lib/assistant/lib/storage";
import type { BadgeProgress, BadgeRarity, BadgeType } from "@/lib/assistant/types";
import { BADGE_DEFINITIONS, getBadgeRarityColor } from "@/lib/assistant/types";
import { assistantKeys } from "./useAssistantQueries";

/**
 * Fetch badge progress from storage adapter
 */
async function fetchBadgeProgress(userId: string): Promise<BadgeProgress[]> {
    const adapter = await initializeAssistantStorage();
    return adapter.getBadgeProgress(userId);
}

/**
 * Hook to compute progress toward badges
 * Uses TanStack Query for caching with refetch on window focus
 */
export function useBadgeProgress(userId: string | null) {
    const queryClient = useQueryClient();

    // Use TanStack Query for badge progress with computed key
    const badgeProgressQuery = useQuery({
        queryKey: [...assistantKeys.badgeList(userId ?? ""), "progress"],
        queryFn: () => fetchBadgeProgress(userId!),
        enabled: !!userId,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
    });

    // Progress data
    const progress = useMemo(() => {
        return badgeProgressQuery.data ?? [];
    }, [badgeProgressQuery.data]);

    // Loading state
    const loading = badgeProgressQuery.isLoading;

    // Error state
    const error = badgeProgressQuery.error
        ? badgeProgressQuery.error instanceof Error
            ? badgeProgressQuery.error.message
            : "Failed to load badge progress"
        : null;

    /**
     * Refresh badge progress
     */
    function refresh(): void {
        if (userId) {
            queryClient.invalidateQueries({
                queryKey: [...assistantKeys.badgeList(userId), "progress"],
            });
        }
    }

    /**
     * Get progress for a specific badge
     */
    function getProgressForBadge(badgeType: BadgeType): BadgeProgress | undefined {
        return progress.find((p) => p.badgeType === badgeType);
    }

    /**
     * Get badges close to completion (>= 75%)
     */
    function getAlmostCompleteBadges(): BadgeProgress[] {
        return progress.filter((p) => p.percentComplete >= 75);
    }

    /**
     * Get badges in progress (25-75%)
     */
    function getInProgressBadges(): BadgeProgress[] {
        return progress.filter((p) => p.percentComplete >= 25 && p.percentComplete < 75);
    }

    /**
     * Get badges not started (<25%)
     */
    function getNotStartedBadges(): BadgeProgress[] {
        return progress.filter((p) => p.percentComplete < 25);
    }

    /**
     * Get badges by rarity
     */
    function getBadgesByRarity(rarity: BadgeRarity): BadgeProgress[] {
        return progress.filter((p) => p.rarity === rarity);
    }

    /**
     * Get next achievable badge (closest to completion)
     */
    function getNextAchievableBadge(): BadgeProgress | null {
        if (progress.length === 0) {
            return null;
        }
        // Already sorted by percent complete descending
        return progress[0];
    }

    /**
     * Get top N badges to focus on
     */
    function getTopBadgesToFocus(n = 3): BadgeProgress[] {
        return progress.slice(0, n);
    }

    /**
     * Get badge icon from definitions
     */
    function getBadgeIcon(badgeType: BadgeType): string {
        const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeType);
        return definition?.icon ?? "Award";
    }

    /**
     * Get badge rarity color
     */
    function getRarityColor(rarity: BadgeRarity): string {
        return getBadgeRarityColor(rarity);
    }

    /**
     * Format progress text
     */
    function formatProgressText(badgeProgress: BadgeProgress): string {
        const { current, target } = badgeProgress;

        // Format based on badge type
        const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeProgress.badgeType);
        if (!definition) {
            return `${current}/${target}`;
        }

        switch (definition.requirement.type) {
            case "task-count":
                return `${current}/${target} tasks`;
            case "streak-days":
                return `${current}/${target} days`;
            case "focus-time": {
                const currentHours = Math.floor(current / 60);
                const targetHours = Math.floor(target / 60);
                return `${currentHours}/${targetHours} hours`;
            }
            case "decision-count":
                return `${current}/${target} decisions`;
            case "communication-count":
                return `${current}/${target} entries`;
            default:
                return `${current}/${target}`;
        }
    }

    /**
     * Get remaining amount text
     */
    function getRemainingText(badgeProgress: BadgeProgress): string {
        const { current, target } = badgeProgress;
        const remaining = target - current;

        if (remaining <= 0) {
            return "Ready to claim!";
        }

        const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeProgress.badgeType);
        if (!definition) {
            return `${remaining} more`;
        }

        switch (definition.requirement.type) {
            case "task-count":
                return `${remaining} more task${remaining === 1 ? "" : "s"}`;
            case "streak-days":
                return `${remaining} more day${remaining === 1 ? "" : "s"}`;
            case "focus-time": {
                const hours = Math.ceil(remaining / 60);
                return `${hours} more hour${hours === 1 ? "" : "s"}`;
            }
            case "decision-count":
                return `${remaining} more decision${remaining === 1 ? "" : "s"}`;
            case "communication-count":
                return `${remaining} more entr${remaining === 1 ? "y" : "ies"}`;
            default:
                return `${remaining} more`;
        }
    }

    /**
     * Get rarity label
     */
    function getRarityLabel(rarity: BadgeRarity): string {
        switch (rarity) {
            case "common":
                return "Common";
            case "uncommon":
                return "Uncommon";
            case "rare":
                return "Rare";
            case "legendary":
                return "Legendary";
        }
    }

    /**
     * Get overall badge completion stats
     */
    function getCompletionStats(): {
        totalBadges: number;
        earnedBadges: number;
        inProgressCount: number;
        averageProgress: number;
    } {
        const totalBadges = BADGE_DEFINITIONS.length;
        const earnedBadges = totalBadges - progress.length;
        const inProgressCount = progress.filter((p) => p.percentComplete > 0).length;
        const averageProgress =
            progress.length > 0 ? progress.reduce((sum, p) => sum + p.percentComplete, 0) / progress.length : 0;

        return {
            totalBadges,
            earnedBadges,
            inProgressCount,
            averageProgress: Math.round(averageProgress),
        };
    }

    /**
     * Get badges grouped by rarity
     */
    function getBadgesGroupedByRarity(): Record<BadgeRarity, BadgeProgress[]> {
        return {
            common: getBadgesByRarity("common"),
            uncommon: getBadgesByRarity("uncommon"),
            rare: getBadgesByRarity("rare"),
            legendary: getBadgesByRarity("legendary"),
        };
    }

    /**
     * Clear error (no-op since TanStack Query manages error state)
     */
    function clearError() {
        // TanStack Query manages error state via refetch
        refresh();
    }

    return {
        // State
        progress,
        loading,
        error,

        // Operations
        refresh,
        getProgressForBadge,

        // Filters
        getAlmostCompleteBadges,
        getInProgressBadges,
        getNotStartedBadges,
        getBadgesByRarity,
        getNextAchievableBadge,
        getTopBadgesToFocus,
        getBadgesGroupedByRarity,

        // Analytics
        getCompletionStats,

        // Utilities
        getBadgeIcon,
        getRarityColor,
        getRarityLabel,
        formatProgressText,
        getRemainingText,
        clearError,

        // Server status (badge progress uses localStorage adapter for computation)
        isServerMode: !badgeProgressQuery.isError,
    };
}
