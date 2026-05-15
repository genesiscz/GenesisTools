import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { EnergyHeatmapData } from "@/lib/assistant/lib/storage/types";
import type { EnergySnapshot, EnergySnapshotInput, FocusQuality } from "@/lib/assistant/types";
import { generateEnergySnapshotId } from "@/lib/assistant/types";
import {
    assistantKeys,
    useAssistantEnergySnapshotsQuery,
    useCreateAssistantEnergySnapshotMutation,
} from "./useAssistantQueries";

export type { EnergyHeatmapData };

export function useEnergyData(userId: string | null) {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string | null>(null);

    const snapshotsQuery = useAssistantEnergySnapshotsQuery(userId, 100);
    const createMutation = useCreateAssistantEnergySnapshotMutation();

    const snapshots: EnergySnapshot[] = useMemo(() => {
        return (snapshotsQuery.data ?? []).map((s) => ({
            id: s.id,
            userId: s.userId,
            timestamp: new Date(s.timestamp),
            focusQuality: s.focusQuality as FocusQuality,
            contextSwitches: s.contextSwitches,
            tasksCompleted: s.tasksCompleted,
            typeOfWork: s.typeOfWork as EnergySnapshot["typeOfWork"],
            notes: s.notes ?? undefined,
            createdAt: new Date(s.createdAt),
        }));
    }, [snapshotsQuery.data]);

    const loading = snapshotsQuery.isLoading;

    async function logSnapshot(input: EnergySnapshotInput): Promise<EnergySnapshot | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const snapshotId = generateEnergySnapshotId();

        try {
            const result = await createMutation.mutateAsync({
                id: snapshotId,
                userId,
                timestamp: input.timestamp?.toISOString() ?? now.toISOString(),
                focusQuality: input.focusQuality,
                contextSwitches: input.contextSwitches ?? 0,
                tasksCompleted: input.tasksCompleted ?? 0,
                typeOfWork: input.typeOfWork,
                notes: input.notes ?? null,
                createdAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to log energy snapshot");
            }

            return {
                id: result.id,
                userId,
                timestamp: input.timestamp ?? now,
                focusQuality: input.focusQuality,
                contextSwitches: input.contextSwitches ?? 0,
                tasksCompleted: input.tasksCompleted ?? 0,
                typeOfWork: input.typeOfWork,
                notes: input.notes,
                createdAt: now,
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to log energy snapshot");
            return null;
        }
    }

    interface EnergyQueryOptions {
        startDate?: Date;
        endDate?: Date;
        workType?: EnergySnapshot["typeOfWork"];
    }

    function getSnapshots(options?: EnergyQueryOptions): EnergySnapshot[] {
        let filtered = [...snapshots];

        if (options?.startDate) {
            filtered = filtered.filter((s) => s.timestamp >= options.startDate!);
        }
        if (options?.endDate) {
            filtered = filtered.filter((s) => s.timestamp <= options.endDate!);
        }
        if (options?.workType) {
            filtered = filtered.filter((s) => s.typeOfWork === options.workType);
        }

        return filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    const getHeatmapData = useCallback(
        (startDate: Date, endDate: Date): EnergyHeatmapData => {
            const filtered = snapshots.filter((s) => s.timestamp >= startDate && s.timestamp <= endDate);

            if (filtered.length === 0) {
                return {
                    cells: [],
                    hourlyAverages: {},
                    dailyAverages: {},
                    peakTime: { hour: 9, day: 1, quality: 0 },
                    lowTime: { hour: 15, day: 5, quality: 0 },
                };
            }

            const hourlyGroups: Record<number, number[]> = {};
            const dailyGroups: Record<number, number[]> = {};
            const cellMap: Map<string, { total: number; count: number }> = new Map();

            for (const s of filtered) {
                const hour = s.timestamp.getHours();
                const day = s.timestamp.getDay();
                const date = s.timestamp.toISOString().split("T")[0];
                const cellKey = `${date}-${hour}`;

                if (!hourlyGroups[hour]) {
                    hourlyGroups[hour] = [];
                }
                if (!dailyGroups[day]) {
                    dailyGroups[day] = [];
                }

                hourlyGroups[hour].push(s.focusQuality);
                dailyGroups[day].push(s.focusQuality);

                const existing = cellMap.get(cellKey) ?? { total: 0, count: 0 };
                cellMap.set(cellKey, {
                    total: existing.total + s.focusQuality,
                    count: existing.count + 1,
                });
            }

            const hourlyAverages: Record<number, number> = {};
            for (const [hour, values] of Object.entries(hourlyGroups)) {
                hourlyAverages[parseInt(hour, 10)] = values.reduce((a, b) => a + b, 0) / values.length;
            }

            const dailyAverages: Record<number, number> = {};
            for (const [day, values] of Object.entries(dailyGroups)) {
                dailyAverages[parseInt(day, 10)] = values.reduce((a, b) => a + b, 0) / values.length;
            }

            const cells = Array.from(cellMap.entries()).map(([key, data]) => {
                const parts = key.split("-");
                const hour = parseInt(parts[parts.length - 1], 10);
                const date = parts.slice(0, -1).join("-");
                return {
                    date,
                    hour,
                    focusQuality: data.total / data.count,
                    count: data.count,
                };
            });

            let peakTime = { hour: 9, day: 1, quality: 0 };
            let lowTime = { hour: 15, day: 5, quality: 5 };

            for (const [hour, quality] of Object.entries(hourlyAverages)) {
                const h = parseInt(hour, 10);
                if (quality > peakTime.quality) {
                    peakTime = { hour: h, day: 0, quality };
                }
                if (quality < lowTime.quality) {
                    lowTime = { hour: h, day: 0, quality };
                }
            }

            return { cells, hourlyAverages, dailyAverages, peakTime, lowTime };
        },
        [snapshots]
    );

    function getTodaySnapshots(): EnergySnapshot[] {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return snapshots.filter((s) => s.timestamp >= today);
    }

    function getWeekSnapshots(): EnergySnapshot[] {
        const startOfWeek = new Date();
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        return snapshots.filter((s) => s.timestamp >= startOfWeek);
    }

    function getAverageFocusQuality(snapshotList?: EnergySnapshot[]): number {
        const list = snapshotList ?? snapshots;
        if (list.length === 0) {
            return 0;
        }
        return list.reduce((sum, s) => sum + s.focusQuality, 0) / list.length;
    }

    function getFocusQualityTrend(): "improving" | "declining" | "stable" {
        if (snapshots.length < 5) {
            return "stable";
        }

        const recent = snapshots.slice(0, 5);
        const previous = snapshots.slice(5, 10);

        if (previous.length < 5) {
            return "stable";
        }

        const recentAvg = getAverageFocusQuality(recent);
        const previousAvg = getAverageFocusQuality(previous);

        const diff = recentAvg - previousAvg;
        if (diff > 0.5) {
            return "improving";
        }
        if (diff < -0.5) {
            return "declining";
        }
        return "stable";
    }

    function getTotalContextSwitches(snapshotList?: EnergySnapshot[]): number {
        const list = snapshotList ?? snapshots;
        return list.reduce((sum, s) => sum + s.contextSwitches, 0);
    }

    function getSnapshotsByWorkType(workType: EnergySnapshot["typeOfWork"]): EnergySnapshot[] {
        return snapshots.filter((s) => s.typeOfWork === workType);
    }

    function getWorkTypeDistribution(): Record<string, number> {
        if (snapshots.length === 0) {
            return {};
        }

        const counts: Record<string, number> = {};
        for (const s of snapshots) {
            counts[s.typeOfWork] = (counts[s.typeOfWork] || 0) + 1;
        }

        const distribution: Record<string, number> = {};
        for (const [type, count] of Object.entries(counts)) {
            distribution[type] = (count / snapshots.length) * 100;
        }

        return distribution;
    }

    function getBestFocusHours(): { hour: number; averageQuality: number }[] {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 14);

        const heatmap = getHeatmapData(startDate, endDate);

        return Object.entries(heatmap.hourlyAverages)
            .map(([hour, quality]) => ({
                hour: parseInt(hour, 10),
                averageQuality: quality,
            }))
            .sort((a, b) => b.averageQuality - a.averageQuality)
            .slice(0, 3);
    }

    function getBestFocusDays(): { day: string; averageQuality: number }[] {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 28);

        const heatmap = getHeatmapData(startDate, endDate);

        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

        return Object.entries(heatmap.dailyAverages)
            .map(([day, quality]) => ({
                day: dayNames[parseInt(day, 10)],
                averageQuality: quality,
            }))
            .sort((a, b) => b.averageQuality - a.averageQuality)
            .slice(0, 3);
    }

    function getFocusQualityColor(quality: FocusQuality): string {
        if (quality >= 4) {
            return "text-green-400";
        }
        if (quality >= 3) {
            return "text-yellow-400";
        }
        if (quality >= 2) {
            return "text-orange-400";
        }
        return "text-red-400";
    }

    function getFocusQualityLabel(quality: FocusQuality): string {
        switch (quality) {
            case 5:
                return "Excellent";
            case 4:
                return "Good";
            case 3:
                return "Average";
            case 2:
                return "Poor";
            case 1:
                return "Very Poor";
        }
    }

    function clearError() {
        setError(null);
    }

    function refresh() {
        if (userId) {
            queryClient.invalidateQueries({ queryKey: assistantKeys.energySnapshotList(userId) });
        }
    }

    return {
        snapshots,
        loading,
        error,
        logSnapshot,
        getSnapshots,
        getHeatmapData,
        getTodaySnapshots,
        getWeekSnapshots,
        getSnapshotsByWorkType,
        getAverageFocusQuality,
        getFocusQualityTrend,
        getTotalContextSwitches,
        getWorkTypeDistribution,
        getBestFocusHours,
        getBestFocusDays,
        getFocusQualityColor,
        getFocusQualityLabel,
        clearError,
        refresh,
    };
}
