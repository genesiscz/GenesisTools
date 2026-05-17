import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { DistractionStats } from "@/lib/assistant/lib/storage/types";
import type { Distraction, DistractionInput } from "@/lib/assistant/types";
import { generateDistractionId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantDistractionsQuery,
    useCreateAssistantDistractionMutation,
} from "./useAssistantQueries";

export type { DistractionStats };

export function useDistractions(userId: string | null) {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string | null>(null);

    const distractionsQuery = useAssistantDistractionsQuery(userId, 100);
    const createMutation = useCreateAssistantDistractionMutation();

    const distractions: Distraction[] = useMemo(() => {
        return (distractionsQuery.data ?? []).map((d) => ({
            id: d.id,
            userId: d.userId,
            source: d.source as Distraction["source"],
            taskInterrupted: d.taskInterrupted ?? undefined,
            duration: d.duration ?? undefined,
            resumedTask: d.resumedTask === 1,
            timestamp: new Date(d.timestamp),
            createdAt: new Date(d.createdAt),
        }));
    }, [distractionsQuery.data]);

    const loading = distractionsQuery.isLoading;

    async function logDistraction(input: DistractionInput): Promise<Distraction | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const distractionId = generateDistractionId();

        try {
            const result = await createMutation.mutateAsync({
                id: distractionId,
                userId,
                source: input.source,
                taskInterrupted: input.taskInterrupted ?? null,
                duration: input.duration ?? null,
                resumedTask: input.resumedTask ? 1 : 0,
                timestamp: now.toISOString(),
                createdAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to log distraction");
            }

            return {
                id: result.id,
                userId,
                source: input.source,
                taskInterrupted: input.taskInterrupted,
                duration: input.duration,
                resumedTask: input.resumedTask ?? false,
                timestamp: now,
                createdAt: now,
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to log distraction");
            return null;
        }
    }

    async function quickLog(source: Distraction["source"], taskInterrupted?: string): Promise<Distraction | null> {
        return logDistraction({
            source,
            taskInterrupted,
            resumedTask: false,
        });
    }

    interface DistractionQueryOptions {
        startDate?: Date;
        endDate?: Date;
        source?: Distraction["source"];
    }

    function getDistractions(options?: DistractionQueryOptions): Distraction[] {
        let filtered = [...distractions];

        if (options?.startDate) {
            filtered = filtered.filter((d) => d.timestamp >= options.startDate!);
        }
        if (options?.endDate) {
            filtered = filtered.filter((d) => d.timestamp <= options.endDate!);
        }
        if (options?.source) {
            filtered = filtered.filter((d) => d.source === options.source);
        }

        return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    const getStats = useCallback(
        (startDate: Date, endDate: Date): DistractionStats => {
            const filtered = distractions.filter((d) => d.timestamp >= startDate && d.timestamp <= endDate);

            if (filtered.length === 0) {
                return {
                    totalDistractions: 0,
                    totalDurationMinutes: 0,
                    bySource: {},
                    averagePerDay: 0,
                    resumptionRate: 0,
                    mostCommonSource: "",
                    mostDisruptiveSource: "",
                };
            }

            const bySource: Record<string, { count: number; duration: number }> = {};
            let totalDuration = 0;
            let resumedCount = 0;

            for (const d of filtered) {
                if (!bySource[d.source]) {
                    bySource[d.source] = { count: 0, duration: 0 };
                }
                bySource[d.source].count += 1;
                bySource[d.source].duration += d.duration ?? 0;

                if (d.duration) {
                    totalDuration += d.duration;
                }

                if (d.resumedTask) {
                    resumedCount++;
                }
            }

            const daysDiff = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

            let mostCommonSource = "";
            let maxCount = 0;
            for (const [source, stats] of Object.entries(bySource)) {
                if (stats.count > maxCount) {
                    maxCount = stats.count;
                    mostCommonSource = source;
                }
            }

            let mostDisruptiveSource = "";
            let maxDuration = 0;
            for (const [source, stats] of Object.entries(bySource)) {
                if (stats.duration > maxDuration) {
                    maxDuration = stats.duration;
                    mostDisruptiveSource = source;
                }
            }

            return {
                totalDistractions: filtered.length,
                totalDurationMinutes: totalDuration,
                bySource,
                averagePerDay: filtered.length / daysDiff,
                resumptionRate: (resumedCount / filtered.length) * 100,
                mostCommonSource,
                mostDisruptiveSource,
            };
        },
        [distractions]
    );

    function getTodayDistractions(): Distraction[] {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return distractions.filter((d) => d.timestamp >= today);
    }

    function getBySource(source: Distraction["source"]): Distraction[] {
        return distractions.filter((d) => d.source === source);
    }

    function getByTask(taskId: string): Distraction[] {
        return distractions.filter((d) => d.taskInterrupted === taskId);
    }

    function getTodayCount(): number {
        return getTodayDistractions().length;
    }

    function getMostCommonSource(): Distraction["source"] | null {
        if (distractions.length === 0) {
            return null;
        }

        const counts: Record<string, number> = {};
        for (const d of distractions) {
            counts[d.source] = (counts[d.source] || 0) + 1;
        }

        let maxSource: string | null = null;
        let maxCount = 0;
        for (const [source, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                maxSource = source;
            }
        }

        return maxSource as Distraction["source"];
    }

    function getSourceIcon(source: Distraction["source"]): string {
        switch (source) {
            case "slack":
                return "MessageSquare";
            case "email":
                return "Mail";
            case "meeting":
                return "Users";
            case "coworker":
                return "User";
            case "hunger":
                return "Coffee";
            case "other":
                return "AlertCircle";
        }
    }

    function getSourceLabel(source: Distraction["source"]): string {
        switch (source) {
            case "slack":
                return "Slack/Chat";
            case "email":
                return "Email";
            case "meeting":
                return "Unplanned Meeting";
            case "coworker":
                return "Coworker Interruption";
            case "hunger":
                return "Hunger/Break";
            case "other":
                return "Other";
        }
    }

    function getResumptionRate(): number {
        if (distractions.length === 0) {
            return 0;
        }
        const resumed = distractions.filter((d) => d.resumedTask).length;
        return (resumed / distractions.length) * 100;
    }

    function getTodayDurationMinutes(): number {
        return getTodayDistractions().reduce((sum, d) => sum + (d.duration ?? 0), 0);
    }

    function formatDuration(minutes: number | undefined): string {
        if (!minutes) {
            return "Unknown";
        }
        if (minutes < 60) {
            return `${minutes}m`;
        }
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }

    const getDistractionTrend = useCallback((): "improving" | "worsening" | "stable" => {
        const now = new Date();
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setDate(now.getDate() - now.getDay());
        startOfThisWeek.setHours(0, 0, 0, 0);

        const startOfLastWeek = new Date(startOfThisWeek);
        startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

        const thisWeek = distractions.filter((d) => d.timestamp >= startOfThisWeek && d.timestamp <= now);
        const lastWeek = distractions.filter((d) => d.timestamp >= startOfLastWeek && d.timestamp < startOfThisWeek);

        const daysPassed = Math.ceil((now.getTime() - startOfThisWeek.getTime()) / (1000 * 60 * 60 * 24));
        const thisWeekDaily = thisWeek.length / Math.max(daysPassed, 1);
        const lastWeekDaily = lastWeek.length / 7;

        const diff = thisWeekDaily - lastWeekDaily;
        if (diff < -1) {
            return "improving";
        }
        if (diff > 1) {
            return "worsening";
        }
        return "stable";
    }, [distractions]);

    function clearError() {
        setError(null);
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.distractionList(userId) });
        }
    }

    return {
        distractions,
        loading,
        error,
        logDistraction,
        quickLog,
        getDistractions,
        getStats,
        getTodayDistractions,
        getBySource,
        getByTask,
        getTodayCount,
        getMostCommonSource,
        getResumptionRate,
        getTodayDurationMinutes,
        getDistractionTrend,
        getSourceIcon,
        getSourceLabel,
        formatDuration,
        clearError,
        refresh,
    };
}
