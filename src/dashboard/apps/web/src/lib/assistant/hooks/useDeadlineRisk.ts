import { useEffect, useState } from "react";
import { getAssistantStorageAdapter, initializeAssistantStorage } from "@/lib/assistant/lib/storage";
import type { DeadlineRisk, DeadlineRiskInput, Task } from "@/lib/assistant/types";

/**
 * Hook to calculate and manage deadline risks
 */
export function useDeadlineRisk(userId: string | null) {
    const [risks, setRisks] = useState<DeadlineRisk[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Load existing risks on mount
    useEffect(() => {
        if (!userId) {
            setRisks([]);
            setLoading(false);
            return;
        }

        const currentUserId = userId;
        let mounted = true;

        async function load() {
            setLoading(true);
            try {
                await initializeAssistantStorage();
                const adapter = getAssistantStorageAdapter();
                const data = await adapter.getDeadlineRisks(currentUserId);
                if (mounted) {
                    setRisks(data);
                }
            } catch (err) {
                if (mounted) {
                    setError(err instanceof Error ? err.message : "Failed to load deadline risks");
                }
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        }

        load();

        return () => {
            mounted = false;
        };
    }, [userId]);

    /**
     * Calculate deadline risk for a task
     */
    async function calculateRisk(input: DeadlineRiskInput): Promise<DeadlineRisk | null> {
        if (!userId) {
            return null;
        }

        try {
            const adapter = getAssistantStorageAdapter();
            const risk = await adapter.calculateDeadlineRisk(input, userId);

            // Update local state
            setRisks((prev) => {
                // Remove any existing risk for this task, add new one
                const filtered = prev.filter((r) => r.taskId !== input.taskId);
                return [risk, ...filtered];
            });

            return risk;
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to calculate deadline risk");
            return null;
        }
    }

    /**
     * Calculate risks for all tasks with deadlines
     */
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

    /**
     * Get risk for a specific task
     */
    async function getRiskForTask(taskId: string): Promise<DeadlineRisk | null> {
        // Check local state first
        const cached = risks.find((r) => r.taskId === taskId);
        if (cached) {
            // Check if it's recent (within last hour)
            const age = Date.now() - new Date(cached.calculatedAt).getTime();
            if (age < 60 * 60 * 1000) {
                return cached;
            }
        }

        // Fetch fresh data
        try {
            const adapter = getAssistantStorageAdapter();
            return await adapter.getDeadlineRiskForTask(taskId);
        } catch {
            return null;
        }
    }

    /**
     * Get high-risk tasks (red level)
     */
    function getHighRiskTasks(): DeadlineRisk[] {
        return risks.filter((r) => r.riskLevel === "red");
    }

    /**
     * Get medium-risk tasks (yellow level)
     */
    function getMediumRiskTasks(): DeadlineRisk[] {
        return risks.filter((r) => r.riskLevel === "yellow");
    }

    /**
     * Get low-risk tasks (green level)
     */
    function getLowRiskTasks(): DeadlineRisk[] {
        return risks.filter((r) => r.riskLevel === "green");
    }

    /**
     * Get tasks sorted by risk level
     */
    function getRisksSortedByLevel(): DeadlineRisk[] {
        const levelOrder = { red: 0, yellow: 1, green: 2 };
        return [...risks].sort((a, b) => levelOrder[a.riskLevel] - levelOrder[b.riskLevel]);
    }

    /**
     * Get recommended action label
     */
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

    /**
     * Get risk level color
     */
    function getRiskLevelColor(level: DeadlineRisk["riskLevel"]): {
        bg: string;
        border: string;
        text: string;
    } {
        switch (level) {
            case "green":
                return {
                    bg: "bg-green-500/10",
                    border: "border-green-500/30",
                    text: "text-green-400",
                };
            case "yellow":
                return {
                    bg: "bg-yellow-500/10",
                    border: "border-yellow-500/30",
                    text: "text-yellow-400",
                };
            case "red":
                return {
                    bg: "bg-red-500/10",
                    border: "border-red-500/30",
                    text: "text-red-400",
                };
        }
    }

    /**
     * Get risk level label
     */
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

    /**
     * Format days late/early
     */
    function formatDaysLate(daysLate: number): string {
        if (daysLate > 0) {
            return `${daysLate} day${daysLate === 1 ? "" : "s"} late`;
        } else if (daysLate < 0) {
            return `${Math.abs(daysLate)} day${Math.abs(daysLate) === 1 ? "" : "s"} early`;
        }
        return "On deadline";
    }

    /**
     * Estimate task completion percentage based on status
     * This is a simple heuristic - can be customized
     */
    function estimateTaskCompletion(task: Task): number {
        switch (task.status) {
            case "backlog":
                return 0;
            case "in-progress":
                // Estimate based on time spent vs average
                if (task.focusTimeLogged > 0) {
                    // Assume 4 hours average per task
                    return Math.min((task.focusTimeLogged / 240) * 100, 80);
                }
                return 25;
            case "blocked":
                return 30; // Assume some progress before blocking
            case "completed":
                return 100;
        }
    }

    /**
     * Get overall risk summary
     */
    function getRiskSummary(): {
        total: number;
        red: number;
        yellow: number;
        green: number;
        averageDaysLate: number;
    } {
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

    /**
     * Clear error
     */
    function clearError() {
        setError(null);
    }

    return {
        // State
        risks,
        loading,
        error,

        // Operations
        calculateRisk,
        calculateAllRisks,
        getRiskForTask,

        // Filters
        getHighRiskTasks,
        getMediumRiskTasks,
        getLowRiskTasks,
        getRisksSortedByLevel,

        // Analytics
        getRiskSummary,
        estimateTaskCompletion,

        // Utilities
        getRecommendedActionLabel,
        getRiskLevelColor,
        getRiskLevelLabel,
        formatDaysLate,
        clearError,
    };
}
