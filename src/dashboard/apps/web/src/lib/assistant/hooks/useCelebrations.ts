import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Celebration, CelebrationTier, CompletionType } from "@/lib/assistant/types";
import { generateCelebrationId, getCelebrationTierInfo } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantCelebrationsQuery,
    useCreateAssistantCelebrationMutation,
    useDismissAssistantCelebrationMutation,
    useMarkAssistantCelebrationShownMutation,
} from "./useAssistantQueries";

export function useCelebrations(userId: string | null) {
    const queryClient = useQueryClient();
    const [activeCelebration, setActiveCelebration] = useState<Celebration | null>(null);
    const [error, setError] = useState<string | null>(null);
    const autoShowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const celebrationsQuery = useAssistantCelebrationsQuery(userId, true);

    const createMutation = useCreateAssistantCelebrationMutation();
    const markShownMutation = useMarkAssistantCelebrationShownMutation();
    const dismissMutation = useDismissAssistantCelebrationMutation();

    useEffect(() => {
        return () => {
            if (autoShowTimeoutRef.current) {
                clearTimeout(autoShowTimeoutRef.current);
                autoShowTimeoutRef.current = null;
            }
        };
    }, []);

    const pendingCelebrations: Celebration[] = useMemo(() => {
        return (celebrationsQuery.data ?? []).map((c) => ({
            id: c.id,
            userId: c.userId,
            tier: c.tier as CelebrationTier,
            title: c.title,
            message: c.message,
            triggerType: c.triggerType,
            triggerId: c.triggerId ?? undefined,
            shownAt: c.shownAt ? new Date(c.shownAt) : undefined,
            dismissed: c.dismissed === 1,
            createdAt: new Date(c.createdAt),
        }));
    }, [celebrationsQuery.data]);

    const loading = celebrationsQuery.isLoading;

    async function createCelebration(
        tier: CelebrationTier,
        title: string,
        message: string,
        triggerType: Celebration["triggerType"],
        triggerId?: string
    ): Promise<Celebration | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const celebrationId = generateCelebrationId();

        try {
            const result = await createMutation.mutateAsync({
                id: celebrationId,
                userId,
                tier,
                title,
                message,
                triggerType,
                triggerId: triggerId ?? null,
                shownAt: null,
                dismissed: 0,
                createdAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to create celebration");
            }

            return {
                id: result.id,
                userId,
                tier,
                title,
                message,
                triggerType,
                triggerId,
                shownAt: undefined,
                dismissed: false,
                createdAt: now,
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create celebration");
            return null;
        }
    }

    async function showNextCelebration(): Promise<Celebration | null> {
        const pending = pendingCelebrations[0];
        if (!pending || !userId) {
            return null;
        }

        try {
            await markShownMutation.mutateAsync({ id: pending.id, userId });

            const shown: Celebration = {
                ...pending,
                shownAt: new Date(),
            };

            setActiveCelebration(shown);

            const tierInfo = getCelebrationTierInfo(shown.tier);
            autoShowTimeoutRef.current = setTimeout(() => {
                dismissActiveCelebration();
            }, tierInfo.duration);

            return shown;
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to show celebration");
            return null;
        }
    }

    async function dismissActiveCelebration(): Promise<void> {
        const active = activeCelebration;
        if (!active || !userId) {
            return;
        }

        if (autoShowTimeoutRef.current) {
            clearTimeout(autoShowTimeoutRef.current);
            autoShowTimeoutRef.current = null;
        }

        try {
            await dismissMutation.mutateAsync({ id: active.id, userId });
        } catch {
            // Ignore errors, just clear locally
        }

        setActiveCelebration(null);
    }

    async function determineTier(completionType: CompletionType): Promise<CelebrationTier> {
        if (!userId) {
            return "micro";
        }

        // Derive tier from pending celebration count as a heuristic
        const pendingCount = pendingCelebrations.length;
        if (completionType === "streak-milestone" && pendingCount >= 5) {
            return "full";
        }
        if (pendingCount >= 3) {
            return "badge";
        }
        return "micro";
    }

    async function celebrateTaskCompletion(taskId: string, taskTitle: string): Promise<Celebration | null> {
        const tier = await determineTier("task-complete");

        const messages = {
            micro: ["Nice!", "Done!", "Got it!", "Checked off!"],
            badge: ["Awesome work!", "Great progress!", "Keep it up!"],
            full: ["Incredible!", "You're on fire!", "Milestone reached!"],
        };

        const messageList = messages[tier];
        const message = messageList[Math.floor(Math.random() * messageList.length)];

        return createCelebration(tier, message, `Completed: ${taskTitle}`, "task-complete", taskId);
    }

    async function celebrateStreakMilestone(streakDays: number): Promise<Celebration | null> {
        const tier: CelebrationTier = streakDays >= 30 ? "full" : streakDays >= 7 ? "badge" : "micro";

        const milestoneMessages: Record<number, string> = {
            3: "Warming Up!",
            7: "One Week Strong!",
            14: "Two Weeks Unstoppable!",
            30: "Monthly Master!",
            60: "Two Months of Excellence!",
            100: "Century of Consistency!",
        };

        const title = milestoneMessages[streakDays] ?? `${streakDays}-Day Streak!`;
        const message = `You've completed tasks ${streakDays} days in a row!`;

        return createCelebration(tier, title, message, "streak-milestone");
    }

    async function celebrateBadgeEarned(badgeId: string, badgeName: string): Promise<Celebration | null> {
        return createCelebration("badge", "Badge Earned!", `You unlocked: ${badgeName}`, "badge-earned", badgeId);
    }

    function hasPendingCelebrations(): boolean {
        return pendingCelebrations.length > 0;
    }

    function getPendingCount(): number {
        return pendingCelebrations.length;
    }

    function isShowingCelebration(): boolean {
        return activeCelebration !== null;
    }

    function getTierInfo(tier: CelebrationTier) {
        return getCelebrationTierInfo(tier);
    }

    function clearError() {
        setError(null);
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.celebrationList(userId) });
        }
    }

    return {
        pendingCelebrations,
        activeCelebration,
        loading,
        error,
        createCelebration,
        showNextCelebration,
        dismissActiveCelebration,
        determineTier,
        celebrateTaskCompletion,
        celebrateStreakMilestone,
        celebrateBadgeEarned,
        hasPendingCelebrations,
        getPendingCount,
        isShowingCelebration,
        getTierInfo,
        clearError,
        refresh,
    };
}
