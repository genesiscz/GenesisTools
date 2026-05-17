import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import type { AssistantTask } from "@/drizzle";
import {
    assistantKeys,
    useAssistantTasksQuery,
    useCreateAssistantTaskMutation,
} from "@/lib/assistant/hooks/useAssistantQueries";
import { rescheduleTask } from "@/lib/assistant/planner.server";
import type { TaskInput } from "@/lib/assistant/types";
import { ASSISTANT_SYNC_CHANNEL, broadcastInvalidate } from "@/lib/sync/useBroadcastInvalidation";
import type { FocusSessionBlock } from "@/lib/timer/timer-sync.server";
import { aggregateFocusSessions } from "@/lib/timer/timer-sync.server";

/** Dev fallback userId when no WorkOS session is present. */
const DEV_USER_ID = "dev-user";

export interface ScheduledTask extends AssistantTask {
    scheduledStart: string;
    scheduledEnd: string;
}

export function usePlannerData() {
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    const tasksQuery = useAssistantTasksQuery(userId);
    const rawTasks: AssistantTask[] = tasksQuery.data ?? [];

    // Split tasks into scheduled (have both start+end) and unscheduled (inbox)
    const scheduledTasks: ScheduledTask[] = rawTasks.filter(
        (t): t is ScheduledTask =>
            t.status !== "completed" && typeof t.scheduledStart === "string" && typeof t.scheduledEnd === "string"
    );

    const unscheduledTasks: AssistantTask[] = rawTasks.filter(
        (t) => t.status !== "completed" && (t.scheduledStart == null || t.scheduledEnd == null)
    );

    const rescheduleMutation = useMutation({
        mutationFn: (input: { id: string; scheduledStart: string | null; scheduledEnd: string | null }) =>
            rescheduleTask({ data: input }),
        onSuccess: () => {
            if (userId) {
                queryClient.invalidateQueries({ queryKey: assistantKeys.taskList(userId) });
                broadcastInvalidate(ASSISTANT_SYNC_CHANNEL, assistantKeys.taskList(userId));
            }
        },
    });

    function scheduleTask(id: string, scheduledStart: string, scheduledEnd: string) {
        return rescheduleMutation.mutateAsync({ id, scheduledStart, scheduledEnd });
    }

    function unscheduleTask(id: string) {
        return rescheduleMutation.mutateAsync({ id, scheduledStart: null, scheduledEnd: null });
    }

    const createMutation = useCreateAssistantTaskMutation();

    function createTask(input: TaskInput, schedule?: { scheduledStart: string; scheduledEnd: string }) {
        if (!userId) {
            return Promise.reject(new Error("No user"));
        }

        const now = new Date().toISOString();

        return createMutation.mutateAsync({
            id: crypto.randomUUID(),
            userId,
            title: input.title,
            description: input.description ?? "",
            deadline: input.deadline ? input.deadline.toISOString() : null,
            urgencyLevel: input.urgencyLevel ?? "nice-to-have",
            isShippingBlocker: input.isShippingBlocker ? 1 : 0,
            linkedGitHub: input.linkedGitHub ?? null,
            status: "backlog",
            scheduledStart: schedule?.scheduledStart ?? null,
            scheduledEnd: schedule?.scheduledEnd ?? null,
            createdAt: now,
            updatedAt: now,
        });
    }

    // ── Focus session ghost blocks (today's completed pomodoros) ─────────────
    const focusSessionsQuery = useQuery({
        queryKey: ["focus-sessions-today", userId],
        queryFn: () => aggregateFocusSessions(),
        enabled: !!userId,
        staleTime: 10_000,
        refetchOnWindowFocus: true,
    });

    const focusSessions: FocusSessionBlock[] = focusSessionsQuery.data ?? [];

    // ── Planner Inbox footer counts ──────────────────────────────────────────
    const todayDateStr = new Date().toLocaleDateString("en-CA"); // "YYYY-MM-DD" in local time
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDateStr = tomorrowDate.toLocaleDateString("en-CA");

    const completedToday: number = rawTasks.filter(
        (t) =>
            t.status === "completed" &&
            t.completedAt !== null &&
            t.completedAt !== undefined &&
            new Date(t.completedAt).toLocaleDateString("en-CA") === todayDateStr
    ).length;

    const deferredToTomorrow: number = rawTasks.filter(
        (t) =>
            t.status !== "completed" &&
            typeof t.scheduledStart === "string" &&
            new Date(t.scheduledStart).toLocaleDateString("en-CA") === tomorrowDateStr
    ).length;

    return {
        userId,
        isLoading: tasksQuery.isLoading,
        error: tasksQuery.error,
        scheduledTasks,
        unscheduledTasks,
        allActiveTasks: rawTasks.filter((t) => t.status !== "completed"),
        scheduleTask,
        unscheduleTask,
        createTask,
        isCreating: createMutation.isPending,
        isRescheduling: rescheduleMutation.isPending,
        // New
        focusSessions,
        completedToday,
        deferredToTomorrow,
    };
}
