import { useMemo, useState } from "react";
import type { DeadlineRisk, DeadlineRiskInput, Task } from "@/lib/assistant/types";
import { generateDeadlineRiskId } from "@/lib/assistant/types";
import { useAssistantDeadlineRisksQuery, useCreateAssistantDeadlineRiskMutation } from "./useAssistantQueries";

function computeRiskLevel(daysLate: number): DeadlineRisk["riskLevel"] {
    if (daysLate > 2) {
        return "red";
    }
    if (daysLate > 0) {
        return "yellow";
    }
    return "green";
}

function computeRecommendedOption(riskLevel: DeadlineRisk["riskLevel"]): DeadlineRisk["recommendedOption"] {
    switch (riskLevel) {
        case "red":
            return "extend";
        case "yellow":
            return "help";
        case "green":
            return "accept";
    }
}

export function useDeadlineRisk(userId: string | null) {
    const [error, setError] = useState<string | null>(null);

    const risksQuery = useAssistantDeadlineRisksQuery(userId);
    const createMutation = useCreateAssistantDeadlineRiskMutation();

    const risks: DeadlineRisk[] = useMemo(() => {
        return (risksQuery.data ?? []).map((r) => ({
            id: r.id,
            userId: r.userId,
            taskId: r.taskId,
            riskLevel: r.riskLevel as DeadlineRisk["riskLevel"],
            projectedCompletionDate: new Date(r.projectedCompletionDate),
            daysLate: r.daysLate,
            daysRemaining: r.daysRemaining,
            percentComplete: r.percentComplete,
            recommendedOption: r.recommendedOption as DeadlineRisk["recommendedOption"],
            calculatedAt: new Date(r.calculatedAt),
            createdAt: new Date(r.createdAt),
        }));
    }, [risksQuery.data]);

    const loading = risksQuery.isLoading;

    async function calculateRisk(input: DeadlineRiskInput): Promise<DeadlineRisk | null> {
        if (!userId) {
            return null;
        }

        const now = new Date();
        const percentComplete = input.percentComplete ?? 0;
        const projectedCompletion = input.projectedCompletionDate ?? now;

        const daysLate = Math.ceil((projectedCompletion.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const daysRemaining = Math.max(0, -daysLate);
        const riskLevel = computeRiskLevel(daysLate);
        const recommendedOption = computeRecommendedOption(riskLevel);

        try {
            const result = await createMutation.mutateAsync({
                id: generateDeadlineRiskId(),
                userId,
                taskId: input.taskId,
                riskLevel,
                projectedCompletionDate: projectedCompletion.toISOString(),
                daysLate,
                daysRemaining,
                percentComplete,
                recommendedOption,
                calculatedAt: now.toISOString(),
                createdAt: now.toISOString(),
            });

            if (!result) {
                throw new Error("Failed to create deadline risk");
            }

            return {
                id: result.id,
                userId,
                taskId: input.taskId,
                riskLevel,
                projectedCompletionDate: projectedCompletion,
                daysLate,
                daysRemaining,
                percentComplete,
                recommendedOption,
                calculatedAt: now,
                createdAt: now,
            };
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to calculate deadline risk");
            return null;
        }
    }

    async function calculateAllRisks(tasks: Task[]): Promise<DeadlineRisk[]> {
        if (!userId) {
            return [];
        }

        const tasksWithDeadlines = tasks.filter((t) => t.deadline && t.status !== "completed");
        const calculatedRisks: DeadlineRisk[] = [];

        for (const task of tasksWithDeadlines) {
            try {
                const risk = await calculateRisk({
                    taskId: task.id,
                    percentComplete: estimateTaskCompletion(task),
                });
                if (risk) {
                    calculatedRisks.push(risk);
                }
            } catch {
                // Continue with other tasks
            }
        }

        return calculatedRisks;
    }

    function getRiskForTask(taskId: string): DeadlineRisk | null {
        const cached = risks.find((r) => r.taskId === taskId);
        if (!cached) {
            return null;
        }

        const age = Date.now() - cached.calculatedAt.getTime();
        if (age < 60 * 60 * 1000) {
            return cached;
        }

        return null;
    }

    function getHighRiskTasks(): DeadlineRisk[] {
        return risks.filter((r) => r.riskLevel === "red");
    }

    function getMediumRiskTasks(): DeadlineRisk[] {
        return risks.filter((r) => r.riskLevel === "yellow");
    }

    function getLowRiskTasks(): DeadlineRisk[] {
        return risks.filter((r) => r.riskLevel === "green");
    }

    function getRisksSortedByLevel(): DeadlineRisk[] {
        const levelOrder: Record<DeadlineRisk["riskLevel"], number> = { red: 0, yellow: 1, green: 2 };
        return [...risks].sort((a, b) => levelOrder[a.riskLevel] - levelOrder[b.riskLevel]);
    }

    function getRecommendedActionLabel(option: DeadlineRisk["recommendedOption"]): string {
        switch (option) {
            case "extend":
                return "Request deadline extension";
            case "help":
                return "Ask for help or pair programming";
            case "scope":
                return "Reduce scope or negotiate MVP";
            case "accept":
                return "On track - continue as planned";
        }
    }

    function getRiskLevelColor(level: DeadlineRisk["riskLevel"]): { bg: string; border: string; text: string } {
        switch (level) {
            case "green":
                return { bg: "bg-green-500/10", border: "border-green-500/30", text: "text-green-400" };
            case "yellow":
                return { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-400" };
            case "red":
                return { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400" };
        }
    }

    function getRiskLevelLabel(level: DeadlineRisk["riskLevel"]): string {
        switch (level) {
            case "green":
                return "On Track";
            case "yellow":
                return "At Risk";
            case "red":
                return "High Risk";
        }
    }

    function formatDaysLate(daysLate: number): string {
        if (daysLate > 0) {
            return `${daysLate} day${daysLate === 1 ? "" : "s"} late`;
        } else if (daysLate < 0) {
            return `${Math.abs(daysLate)} day${Math.abs(daysLate) === 1 ? "" : "s"} early`;
        }
        return "On deadline";
    }

    function estimateTaskCompletion(task: Task): number {
        switch (task.status) {
            case "backlog":
                return 0;
            case "in-progress":
                if (task.focusTimeLogged > 0) {
                    return Math.min((task.focusTimeLogged / 240) * 100, 80);
                }
                return 25;
            case "blocked":
                return 30;
            case "completed":
                return 100;
        }
    }

    function getRiskSummary(): { total: number; red: number; yellow: number; green: number; averageDaysLate: number } {
        const red = getHighRiskTasks().length;
        const yellow = getMediumRiskTasks().length;
        const green = getLowRiskTasks().length;
        const avgDaysLate = risks.length > 0 ? risks.reduce((sum, r) => sum + r.daysLate, 0) / risks.length : 0;

        return {
            total: risks.length,
            red,
            yellow,
            green,
            averageDaysLate: Math.round(avgDaysLate * 10) / 10,
        };
    }

    function clearError() {
        setError(null);
    }

    return {
        risks,
        loading,
        error,
        calculateRisk,
        calculateAllRisks,
        getRiskForTask,
        getHighRiskTasks,
        getMediumRiskTasks,
        getLowRiskTasks,
        getRisksSortedByLevel,
        getRiskSummary,
        estimateTaskCompletion,
        getRecommendedActionLabel,
        getRiskLevelColor,
        getRiskLevelLabel,
        formatDaysLate,
        clearError,
    };
}
