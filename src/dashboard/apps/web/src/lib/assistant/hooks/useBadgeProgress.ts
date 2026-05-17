/**
 * Badge Progress Hook - Derives progress from server data (SQLite via TanStack Query)
 */

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BadgeProgress, BadgeRarity, BadgeType } from "@/lib/assistant/types";
import { BADGE_DEFINITIONS, getBadgeRarityColor } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantBadgesQuery,
    useAssistantStreakQuery,
    useAssistantTasksQuery,
} from "./useAssistantQueries";

/**
 * Hook to compute progress toward badges from server data
 */
export function useBadgeProgress(userId: string | null) {
    const queryClient = useQueryClient();

    const badgesQuery = useAssistantBadgesQuery(userId);
    const tasksQuery = useAssistantTasksQuery(userId);
    const streakQuery = useAssistantStreakQuery(userId);

    const progress = useMemo<BadgeProgress[]>(() => {
        const earnedBadges = badgesQuery.data ?? [];
        const tasks = tasksQuery.data ?? [];
        const streak = streakQuery.data;

        const earnedTypes = new Set(earnedBadges.map((b) => b.badgeType));
        const completedTasks = tasks.filter((t) => t.status === "completed");
        const currentStreak = streak?.currentStreakDays ?? 0;

        const result: BadgeProgress[] = [];

        for (const def of BADGE_DEFINITIONS) {
            if (earnedTypes.has(def.type)) {
                continue;
            }

            let current = 0;
            let target = 1;

            switch (def.requirement.type) {
                case "task-count":
                    current = completedTasks.length;
                    target = def.requirement.value;
                    break;
                case "streak-days":
                    current = currentStreak;
                    target = def.requirement.value;
                    break;
                case "first-action":
                    current = completedTasks.length > 0 ? 1 : 0;
                    target = 1;
                    break;
                default:
                    current = 0;
                    target = 1;
            }

            const percentComplete = Math.min(Math.round((current / target) * 100), 100);

            result.push({
                badgeType: def.type,
                displayName: def.displayName,
                description: def.description,
                rarity: def.rarity,
                current,
                target,
                percentComplete,
            });
        }

        // Sort by percent complete descending
        result.sort((a, b) => b.percentComplete - a.percentComplete);

        return result;
    }, [badgesQuery.data, tasksQuery.data, streakQuery.data]);

    const loading = badgesQuery.isLoading || tasksQuery.isLoading || streakQuery.isLoading;
    const error = badgesQuery.error
        ? badgesQuery.error instanceof Error
            ? badgesQuery.error.message
            : "Failed to load badge progress"
        : null;

    function refresh(): void {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.badgeList(userId) });
        }
    }

    function getProgressForBadge(badgeType: BadgeType): BadgeProgress | undefined {
        return progress.find((p) => p.badgeType === badgeType);
    }

    function getAlmostCompleteBadges(): BadgeProgress[] {
        return progress.filter((p) => p.percentComplete >= 75);
    }

    function getInProgressBadges(): BadgeProgress[] {
        return progress.filter((p) => p.percentComplete >= 25 && p.percentComplete < 75);
    }

    function getNotStartedBadges(): BadgeProgress[] {
        return progress.filter((p) => p.percentComplete < 25);
    }

    function getBadgesByRarity(rarity: BadgeRarity): BadgeProgress[] {
        return progress.filter((p) => p.rarity === rarity);
    }

    function getNextAchievableBadge(): BadgeProgress | null {
        return progress[0] ?? null;
    }

    function getTopBadgesToFocus(n = 3): BadgeProgress[] {
        return progress.slice(0, n);
    }

    function getBadgeIcon(badgeType: BadgeType): string {
        const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeType);
        return definition?.icon ?? "Award";
    }

    function getRarityColor(rarity: BadgeRarity): string {
        return getBadgeRarityColor(rarity);
    }

    function formatProgressText(badgeProgress: BadgeProgress): string {
        const { current, target } = badgeProgress;
        const definition = BADGE_DEFINITIONS.find((b) => b.type === badgeProgress.badgeType);
        if (!definition) {
            return `${current}/${target}`;
        }

        switch (definition.requirement.type) {
            case "task-count":
                return `${current}/${target} tasks`;
            case "streak-days":
                return `${current}/${target} days`;
            default:
                return `${current}/${target}`;
        }
    }

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
            default:
                return `${remaining} more`;
        }
    }

    function getRarityLabel(rarity: BadgeRarity): string {
        const labels: Record<BadgeRarity, string> = {
            common: "Common",
            uncommon: "Uncommon",
            rare: "Rare",
            legendary: "Legendary",
        };
        return labels[rarity];
    }

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

    function getBadgesGroupedByRarity(): Record<BadgeRarity, BadgeProgress[]> {
        return {
            common: getBadgesByRarity("common"),
            uncommon: getBadgesByRarity("uncommon"),
            rare: getBadgesByRarity("rare"),
            legendary: getBadgesByRarity("legendary"),
        };
    }

    function clearError() {
        refresh();
    }

    return {
        progress,
        loading,
        error,
        refresh,
        getProgressForBadge,
        getAlmostCompleteBadges,
        getInProgressBadges,
        getNotStartedBadges,
        getBadgesByRarity,
        getNextAchievableBadge,
        getTopBadgesToFocus,
        getBadgesGroupedByRarity,
        getCompletionStats,
        getBadgeIcon,
        getRarityColor,
        getRarityLabel,
        formatProgressText,
        getRemainingText,
        clearError,
    };
}
