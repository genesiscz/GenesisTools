/**
 * Weekly Review Hook - Server-first with localStorage fallback
 *
 * Uses TanStack Query for server data with refetchOnWindowFocus.
 * Falls back to localStorage when server is unavailable.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getAssistantStorageAdapter, initializeAssistantStorage } from "@/lib/assistant/lib/storage";
import type { WeeklyReview, WeeklyReviewInput } from "@/lib/assistant/types";
import { generateWeeklyReviewId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantCurrentWeekReviewQuery,
    useAssistantWeeklyReviewsQuery,
    useCreateAssistantWeeklyReviewMutation,
} from "./useAssistantQueries";

/**
 * Hook to generate and manage weekly reviews
 * Server-first with localStorage fallback
 */
export function useWeeklyReview(userId: string | null) {
    const queryClient = useQueryClient();
    const [fallbackMode, setFallbackMode] = useState(false);
    const [fallbackReviews, setFallbackReviews] = useState<WeeklyReview[]>([]);
    const [fallbackCurrentReview, setFallbackCurrentReview] = useState<WeeklyReview | null>(null);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Server queries
    const reviewsQuery = useAssistantWeeklyReviewsQuery(userId, 10);
    const currentReviewQuery = useAssistantCurrentWeekReviewQuery(userId);

    // Server mutations
    const createMutation = useCreateAssistantWeeklyReviewMutation();

    // Determine if we should use fallback mode
    const useFallback = fallbackMode || (reviewsQuery.isError && !reviewsQuery.data);

    // Initialize localStorage fallback if server fails
    useEffect(() => {
        if (!userId) {
            return;
        }

        if (reviewsQuery.isError && !fallbackMode) {
            const currentUserId = userId;

            async function loadFallback() {
                try {
                    const adapter = await initializeAssistantStorage();
                    const data = await adapter.getWeeklyReviews(currentUserId, 10);
                    const current = await adapter.getCurrentWeekReview(currentUserId);

                    setFallbackMode(true);
                    setFallbackReviews(data);
                    setFallbackCurrentReview(current);
                } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to load fallback");
                }
            }

            loadFallback();
        }
    }, [userId, reviewsQuery.isError, fallbackMode]);

    // Convert server reviews to app WeeklyReview type
    const reviews: WeeklyReview[] = useMemo(() => {
        if (useFallback) {
            return fallbackReviews;
        }

        return (reviewsQuery.data ?? []).map((r) => ({
            id: r.id,
            userId: r.userId,
            weekStart: new Date(r.weekStart),
            weekEnd: new Date(r.weekEnd),
            tasksCompleted: r.tasksCompleted,
            tasksCompletedLastWeek: r.tasksCompletedLastWeek,
            tasksCreated: r.tasksCreated,
            deadlinesHit: r.deadlinesHit,
            deadlinesTotal: r.deadlinesTotal,
            deepFocusMinutes: r.deepFocusMinutes,
            meetingMinutes: r.meetingMinutes,
            totalMinutes: r.totalMinutes,
            averageEnergy: r.averageEnergy,
            averageFocusQuality: r.averageFocusQuality,
            totalDistractions: r.totalDistractions,
            topDistraction: r.topDistraction ?? undefined,
            streakDays: r.streakDays,
            badgesEarned: (r.badgesEarned as string[]) ?? [],
            highlights: (r.highlights as string[]) ?? [],
            areasToImprove: (r.areasToImprove as string[]) ?? [],
            generatedAt: new Date(r.generatedAt),
            createdAt: new Date(r.createdAt),
        }));
    }, [useFallback, fallbackReviews, reviewsQuery.data]);

    // Convert server current review
    const currentReview: WeeklyReview | null = useMemo(() => {
        if (useFallback) {
            return fallbackCurrentReview;
        }
        if (!currentReviewQuery.data) {
            return null;
        }

        const r = currentReviewQuery.data;
        return {
            id: r.id,
            userId: r.userId,
            weekStart: new Date(r.weekStart),
            weekEnd: new Date(r.weekEnd),
            tasksCompleted: r.tasksCompleted,
            tasksCompletedLastWeek: r.tasksCompletedLastWeek,
            tasksCreated: r.tasksCreated,
            deadlinesHit: r.deadlinesHit,
            deadlinesTotal: r.deadlinesTotal,
            deepFocusMinutes: r.deepFocusMinutes,
            meetingMinutes: r.meetingMinutes,
            totalMinutes: r.totalMinutes,
            averageEnergy: r.averageEnergy,
            averageFocusQuality: r.averageFocusQuality,
            totalDistractions: r.totalDistractions,
            topDistraction: r.topDistraction ?? undefined,
            streakDays: r.streakDays,
            badgesEarned: (r.badgesEarned as string[]) ?? [],
            highlights: (r.highlights as string[]) ?? [],
            areasToImprove: (r.areasToImprove as string[]) ?? [],
            generatedAt: new Date(r.generatedAt),
            createdAt: new Date(r.createdAt),
        };
    }, [useFallback, fallbackCurrentReview, currentReviewQuery.data]);

    // Loading state
    const loading = reviewsQuery.isLoading || currentReviewQuery.isLoading;

    /**
     * Generate a weekly review for a specific week
     */
    async function generateReview(input: WeeklyReviewInput): Promise<WeeklyReview | null> {
        if (!userId) {
            return null;
        }

        setGenerating(true);
        const now = new Date();
        const reviewId = generateWeeklyReviewId();

        try {
            if (useFallback) {
                const adapter = getAssistantStorageAdapter();
                const review = await adapter.generateWeeklyReview(input, userId);

                setFallbackReviews((prev) => [review, ...prev.filter((r) => r.id !== review.id)]);

                // Update current review if it's this week
                const startOfWeek = new Date(now);
                startOfWeek.setDate(now.getDate() - now.getDay());
                startOfWeek.setHours(0, 0, 0, 0);

                if (new Date(review.weekStart).getTime() === startOfWeek.getTime()) {
                    setFallbackCurrentReview(review);
                }

                return review;
            }

            // For server mode, we need to compute the review data
            // This would typically be done server-side, but we'll compute locally
            const adapter = await initializeAssistantStorage();
            const localReview = await adapter.generateWeeklyReview(input, userId);

            const result = await createMutation.mutateAsync({
                id: reviewId,
                userId,
                weekStart: input.weekStart.toISOString(),
                weekEnd: input.weekEnd.toISOString(),
                tasksCompleted: localReview.tasksCompleted,
                tasksCompletedLastWeek: localReview.tasksCompletedLastWeek,
                tasksCreated: localReview.tasksCreated,
                deadlinesHit: localReview.deadlinesHit,
                deadlinesTotal: localReview.deadlinesTotal,
                deepFocusMinutes: localReview.deepFocusMinutes,
                meetingMinutes: localReview.meetingMinutes,
                totalMinutes: localReview.totalMinutes,
                averageEnergy: localReview.averageEnergy,
                averageFocusQuality: localReview.averageFocusQuality,
                totalDistractions: localReview.totalDistractions,
                topDistraction: localReview.topDistraction ?? null,
                streakDays: localReview.streakDays,
                badgesEarned: localReview.badgesEarned,
                highlights: localReview.highlights,
                areasToImprove: localReview.areasToImprove,
                generatedAt: now.toISOString(),
                createdAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to generate weekly review");
            }

            return localReview;
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to generate weekly review");
            return null;
        } finally {
            setGenerating(false);
        }
    }

    /**
     * Generate review for current week
     */
    async function generateCurrentWeekReview(): Promise<WeeklyReview | null> {
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(endOfWeek.getDate() + 6);
        endOfWeek.setHours(23, 59, 59, 999);

        return generateReview({
            weekStart: startOfWeek,
            weekEnd: endOfWeek,
        });
    }

    /**
     * Generate review for last week
     */
    async function generateLastWeekReview(): Promise<WeeklyReview | null> {
        const now = new Date();
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setDate(now.getDate() - now.getDay());
        startOfThisWeek.setHours(0, 0, 0, 0);

        const startOfLastWeek = new Date(startOfThisWeek);
        startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

        const endOfLastWeek = new Date(startOfThisWeek);
        endOfLastWeek.setDate(endOfLastWeek.getDate() - 1);
        endOfLastWeek.setHours(23, 59, 59, 999);

        return generateReview({
            weekStart: startOfLastWeek,
            weekEnd: endOfLastWeek,
        });
    }

    /**
     * Get a review by ID
     */
    function getReview(id: string): WeeklyReview | undefined {
        return reviews.find((r) => r.id === id);
    }

    /**
     * Get review for a specific week
     */
    function getReviewForWeek(weekStart: Date): WeeklyReview | undefined {
        const weekStartTime = new Date(weekStart);
        weekStartTime.setHours(0, 0, 0, 0);

        return reviews.find((r) => {
            const reviewStart = new Date(r.weekStart);
            reviewStart.setHours(0, 0, 0, 0);
            return reviewStart.getTime() === weekStartTime.getTime();
        });
    }

    /**
     * Check if current week review exists
     */
    function hasCurrentWeekReview(): boolean {
        return currentReview !== null;
    }

    /**
     * Get week-over-week comparison
     */
    function getWeekOverWeekComparison(): {
        tasksChange: number;
        tasksChangePercent: number;
        direction: "up" | "down" | "same";
    } | null {
        if (!currentReview) {
            return null;
        }

        const change = currentReview.tasksCompleted - currentReview.tasksCompletedLastWeek;
        const percentChange =
            currentReview.tasksCompletedLastWeek > 0
                ? (change / currentReview.tasksCompletedLastWeek) * 100
                : currentReview.tasksCompleted > 0
                  ? 100
                  : 0;

        return {
            tasksChange: change,
            tasksChangePercent: Math.round(percentChange),
            direction: change > 0 ? "up" : change < 0 ? "down" : "same",
        };
    }

    /**
     * Get deadline hit rate
     */
    function getDeadlineHitRate(review?: WeeklyReview): number {
        const r = review ?? currentReview;
        if (!r || r.deadlinesTotal === 0) {
            return 0;
        }
        return (r.deadlinesHit / r.deadlinesTotal) * 100;
    }

    /**
     * Get deep focus percentage
     */
    function getDeepFocusPercentage(review?: WeeklyReview): number {
        const r = review ?? currentReview;
        if (!r || r.totalMinutes === 0) {
            return 0;
        }
        return (r.deepFocusMinutes / r.totalMinutes) * 100;
    }

    /**
     * Get meeting percentage
     */
    function getMeetingPercentage(review?: WeeklyReview): number {
        const r = review ?? currentReview;
        if (!r || r.totalMinutes === 0) {
            return 0;
        }
        return (r.meetingMinutes / r.totalMinutes) * 100;
    }

    /**
     * Format week range
     */
    function formatWeekRange(review: WeeklyReview): string {
        const startDate = review.weekStart;
        const endDate = review.weekEnd;

        const startMonth = startDate.toLocaleString("default", { month: "short" });
        const endMonth = endDate.toLocaleString("default", { month: "short" });

        if (startMonth === endMonth) {
            return `${startMonth} ${startDate.getDate()}-${endDate.getDate()}`;
        }
        return `${startMonth} ${startDate.getDate()} - ${endMonth} ${endDate.getDate()}`;
    }

    /**
     * Get energy rating label
     */
    function getEnergyLabel(averageEnergy: number): string {
        if (averageEnergy >= 4) {
            return "Excellent";
        }
        if (averageEnergy >= 3) {
            return "Good";
        }
        if (averageEnergy >= 2) {
            return "Fair";
        }
        return "Low";
    }

    /**
     * Get energy rating color
     */
    function getEnergyColor(averageEnergy: number): string {
        if (averageEnergy >= 4) {
            return "text-green-400";
        }
        if (averageEnergy >= 3) {
            return "text-yellow-400";
        }
        if (averageEnergy >= 2) {
            return "text-orange-400";
        }
        return "text-red-400";
    }

    /**
     * Generate review summary text
     */
    function generateSummaryText(review?: WeeklyReview): string {
        const r = review ?? currentReview;
        if (!r) {
            return "";
        }

        const lines: string[] = [];

        // Productivity headline
        const comparison = getWeekOverWeekComparison();
        if (comparison) {
            if (comparison.direction === "up") {
                lines.push(`Great week! You completed ${comparison.tasksChangePercent}% more tasks than last week.`);
            } else if (comparison.direction === "down") {
                lines.push(`You completed ${Math.abs(comparison.tasksChangePercent)}% fewer tasks than last week.`);
            } else {
                lines.push("You maintained consistent productivity this week.");
            }
        }

        // Streak highlight
        if (r.streakDays > 0) {
            lines.push(`You're on a ${r.streakDays}-day completion streak!`);
        }

        // Badges
        if (r.badgesEarned.length > 0) {
            lines.push(`You earned ${r.badgesEarned.length} new badge${r.badgesEarned.length > 1 ? "s" : ""}!`);
        }

        // Deadlines
        const hitRate = getDeadlineHitRate(r);
        if (r.deadlinesTotal > 0) {
            lines.push(`Deadline hit rate: ${Math.round(hitRate)}% (${r.deadlinesHit}/${r.deadlinesTotal})`);
        }

        return lines.join(" ");
    }

    /**
     * Clear error
     */
    function clearError() {
        setError(null);
    }

    /**
     * Manual refresh
     */
    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.weeklyReviewList(userId) });
            queryClient.invalidateQueries({ queryKey: assistantKeys.weeklyReviewCurrent(userId) });
        }
    }

    return {
        // State
        reviews,
        currentReview,
        loading,
        generating,
        error,

        // Operations
        generateReview,
        generateCurrentWeekReview,
        generateLastWeekReview,
        getReview,
        getReviewForWeek,

        // Checks
        hasCurrentWeekReview,

        // Analytics
        getWeekOverWeekComparison,
        getDeadlineHitRate,
        getDeepFocusPercentage,
        getMeetingPercentage,

        // Utilities
        formatWeekRange,
        getEnergyLabel,
        getEnergyColor,
        generateSummaryText,
        clearError,
        refresh,

        // Server status
        isServerMode: !useFallback,
    };
}
