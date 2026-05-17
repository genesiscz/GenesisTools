import type { Streak } from "@/lib/assistant/types";
import { useAssistantStreakQuery } from "./useAssistantQueries";

/**
 * Hook to access the user's streak state from SQLite via TanStack Query
 */
export function useStreak(userId: string | null) {
    const streakQuery = useAssistantStreakQuery(userId);

    const raw = streakQuery.data ?? null;

    const streak: Streak | null = raw
        ? {
              userId: raw.userId,
              currentStreakDays: raw.currentStreakDays,
              longestStreakDays: raw.longestStreakDays,
              lastTaskCompletionDate: new Date(raw.lastTaskCompletionDate),
              streakResetDate: raw.streakResetDate ? new Date(raw.streakResetDate) : undefined,
          }
        : null;

    function getStreakMessage(): string | null {
        if (!streak) {
            return null;
        }

        const days = streak.currentStreakDays;

        if (days === 0) {
            return null;
        }
        if (days === 1) {
            return "Start of a new streak!";
        }
        if (days < 3) {
            return "Building momentum...";
        }
        if (days < 7) {
            return `${days}-day streak! Keep it up!`;
        }
        if (days < 14) {
            return `${days}-day streak! You're on fire!`;
        }
        if (days < 30) {
            return `${days}-day streak! Unstoppable!`;
        }
        return `${days}-day streak! LEGENDARY!`;
    }

    function isStreakAtRisk(): boolean {
        if (!streak || streak.currentStreakDays === 0) {
            return false;
        }

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const lastCompletion = new Date(streak.lastTaskCompletionDate);
        const lastCompletionDay = new Date(
            lastCompletion.getFullYear(),
            lastCompletion.getMonth(),
            lastCompletion.getDate()
        );

        const daysDiff = Math.floor((today.getTime() - lastCompletionDay.getTime()) / (1000 * 60 * 60 * 24));
        return daysDiff >= 1;
    }

    function getStreakMilestone(): { days: number; message: string } | null {
        if (!streak) {
            return null;
        }

        const days = streak.currentStreakDays;
        const milestones = [3, 7, 14, 30, 60, 100];

        for (const milestone of milestones) {
            if (days === milestone) {
                const messages: Record<number, string> = {
                    3: "Warming Up!",
                    7: "One Week Strong!",
                    14: "Two Weeks Unstoppable!",
                    30: "Monthly Master!",
                    60: "Two Months of Excellence!",
                    100: "Century of Consistency!",
                };
                return { days: milestone, message: messages[milestone] ?? "" };
            }
        }

        return null;
    }

    return {
        streak,
        loading: streakQuery.isLoading,
        getStreakMessage,
        isStreakAtRisk,
        getStreakMilestone,
    };
}
