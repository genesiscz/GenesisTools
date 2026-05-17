import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { WeeklyReview, WeeklyReviewInput } from "@/lib/assistant/types";
import { generateWeeklyReviewId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantCurrentWeekReviewQuery,
    useAssistantWeeklyReviewsQuery,
    useCreateAssistantWeeklyReviewMutation,
} from "./useAssistantQueries";

function mapReview(r: {
    id: string;
    userId: string;
    weekStart: string;
    weekEnd: string;
    tasksCompleted: number;
    tasksCompletedLastWeek: number;
    deadlinesHit: number;
    deadlinesTotal: number;
    deepFocusMinutes: number;
    meetingMinutes: number;
    totalMinutes: number;
    averageEnergy: number;
    streakDays: number;
    badgesEarned: unknown;
    energyByDay: unknown;
    peakFocusTime: string | null;
    lowEnergyTime: string | null;
    insights: unknown;
    recommendations: unknown;
    generatedAt: string;
    createdAt: string;
}): WeeklyReview {
    return {
        id: r.id,
        userId: r.userId,
        weekStart: new Date(r.weekStart),
        weekEnd: new Date(r.weekEnd),
        tasksCompleted: r.tasksCompleted,
        tasksCompletedLastWeek: r.tasksCompletedLastWeek,
        deadlinesHit: r.deadlinesHit,
        deadlinesTotal: r.deadlinesTotal,
        deepFocusMinutes: r.deepFocusMinutes,
        meetingMinutes: r.meetingMinutes,
        totalMinutes: r.totalMinutes,
        averageEnergy: r.averageEnergy,
        streakDays: r.streakDays,
        badgesEarned: (r.badgesEarned as string[]) ?? [],
        energyByDay: (r.energyByDay as Record<string, number>) ?? {},
        peakFocusTime: r.peakFocusTime ?? "",
        lowEnergyTime: r.lowEnergyTime ?? "",
        insights: (r.insights as string[]) ?? [],
        recommendations: (r.recommendations as string[]) ?? [],
        generatedAt: new Date(r.generatedAt),
        createdAt: new Date(r.createdAt),
    };
}

export function useWeeklyReview(userId: string | null) {
    const queryClient = useQueryClient();
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reviewsQuery = useAssistantWeeklyReviewsQuery(userId, 10);
    const currentReviewQuery = useAssistantCurrentWeekReviewQuery(userId);
    const createMutation = useCreateAssistantWeeklyReviewMutation();

    const reviews: WeeklyReview[] = useMemo(() => {
        return (reviewsQuery.data ?? []).map(mapReview);
    }, [reviewsQuery.data]);

    const currentReview: WeeklyReview | null = useMemo(() => {
        if (!currentReviewQuery.data) {
            return null;
        }
        return mapReview(currentReviewQuery.data);
    }, [currentReviewQuery.data]);

    const loading = reviewsQuery.isLoading || currentReviewQuery.isLoading;

    async function generateReview(input: WeeklyReviewInput): Promise<WeeklyReview | null> {
        if (!userId) {
            return null;
        }

        setGenerating(true);
        const now = new Date();
        const reviewId = generateWeeklyReviewId();

        try {
            const result = await createMutation.mutateAsync({
                id: reviewId,
                userId,
                weekStart: input.weekStart.toISOString(),
                weekEnd: input.weekEnd.toISOString(),
                tasksCompleted: 0,
                tasksCompletedLastWeek: 0,
                deadlinesHit: 0,
                deadlinesTotal: 0,
                deepFocusMinutes: 0,
                meetingMinutes: 0,
                totalMinutes: 0,
                averageEnergy: 0,
                streakDays: 0,
                badgesEarned: [],
                generatedAt: now.toISOString(),
                createdAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to generate weekly review");
            }

            return {
                id: result.id,
                userId,
                weekStart: input.weekStart,
                weekEnd: input.weekEnd,
                tasksCompleted: 0,
                tasksCompletedLastWeek: 0,
                deadlinesHit: 0,
                deadlinesTotal: 0,
                deepFocusMinutes: 0,
                meetingMinutes: 0,
                totalMinutes: 0,
                averageEnergy: 0,
                streakDays: 0,
                badgesEarned: [],
                energyByDay: {},
                peakFocusTime: "",
                lowEnergyTime: "",
                insights: [],
                recommendations: [],
                generatedAt: now,
                createdAt: now,
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to generate weekly review");
            return null;
        } finally {
            setGenerating(false);
        }
    }

    async function generateCurrentWeekReview(): Promise<WeeklyReview | null> {
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(endOfWeek.getDate() + 6);
        endOfWeek.setHours(23, 59, 59, 999);

        return generateReview({ weekStart: startOfWeek, weekEnd: endOfWeek });
    }

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

        return generateReview({ weekStart: startOfLastWeek, weekEnd: endOfLastWeek });
    }

    function getReview(id: string): WeeklyReview | undefined {
        return reviews.find((r) => r.id === id);
    }

    function getReviewForWeek(weekStart: Date): WeeklyReview | undefined {
        const weekStartTime = new Date(weekStart);
        weekStartTime.setHours(0, 0, 0, 0);

        return reviews.find((r) => {
            const reviewStart = new Date(r.weekStart);
            reviewStart.setHours(0, 0, 0, 0);
            return reviewStart.getTime() === weekStartTime.getTime();
        });
    }

    function hasCurrentWeekReview(): boolean {
        return currentReview !== null;
    }

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

    function getDeadlineHitRate(review?: WeeklyReview): number {
        const r = review ?? currentReview;
        if (!r || r.deadlinesTotal === 0) {
            return 0;
        }
        return (r.deadlinesHit / r.deadlinesTotal) * 100;
    }

    function getDeepFocusPercentage(review?: WeeklyReview): number {
        const r = review ?? currentReview;
        if (!r || r.totalMinutes === 0) {
            return 0;
        }
        return (r.deepFocusMinutes / r.totalMinutes) * 100;
    }

    function getMeetingPercentage(review?: WeeklyReview): number {
        const r = review ?? currentReview;
        if (!r || r.totalMinutes === 0) {
            return 0;
        }
        return (r.meetingMinutes / r.totalMinutes) * 100;
    }

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

    function generateSummaryText(review?: WeeklyReview): string {
        const r = review ?? currentReview;
        if (!r) {
            return "";
        }

        const lines: string[] = [];
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

        if (r.streakDays > 0) {
            lines.push(`You're on a ${r.streakDays}-day completion streak!`);
        }

        if (r.badgesEarned.length > 0) {
            lines.push(`You earned ${r.badgesEarned.length} new badge${r.badgesEarned.length > 1 ? "s" : ""}!`);
        }

        const hitRate = getDeadlineHitRate(r);
        if (r.deadlinesTotal > 0) {
            lines.push(`Deadline hit rate: ${Math.round(hitRate)}% (${r.deadlinesHit}/${r.deadlinesTotal})`);
        }

        return lines.join(" ");
    }

    function clearError() {
        setError(null);
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.weeklyReviewList(userId) });
            queryClient.invalidateQueries({ queryKey: assistantKeys.currentWeekReview(userId) });
        }
    }

    return {
        reviews,
        currentReview,
        loading,
        generating,
        error,
        generateReview,
        generateCurrentWeekReview,
        generateLastWeekReview,
        getReview,
        getReviewForWeek,
        hasCurrentWeekReview,
        getWeekOverWeekComparison,
        getDeadlineHitRate,
        getDeepFocusPercentage,
        getMeetingPercentage,
        formatWeekRange,
        getEnergyLabel,
        getEnergyColor,
        generateSummaryText,
        clearError,
        refresh,
    };
}
