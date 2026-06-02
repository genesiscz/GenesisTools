import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import type { AssistantTask } from "@/drizzle";
import {
    assistantKeys,
    useAssistantTasksQuery,
    useCreateAssistantTaskMutation,
    useDeleteAssistantTaskMutation,
    useUpdateAssistantTaskMutation,
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

/** "YYYY-MM-DD" in local time for the given ISO timestamp. */
function localDateStr(iso: string): string {
    return new Date(iso).toLocaleDateString("en-CA");
}

/** Same wall-clock time, one day later, as an ISO string. */
function shiftToTomorrow(iso: string): string {
    const d = new Date(iso);
    d.setDate(d.getDate() + 1);
    return d.toISOString();
}

export function usePlannerData() {
    const { user } = useAuth();
    const userId = user?.id ?? (import.meta.env.DEV ? DEV_USER_ID : null);
    const queryClient = useQueryClient();

    const tasksQuery = useAssistantTasksQuery(userId);
    const rawTasks: AssistantTask[] = tasksQuery.data ?? [];

    const todayStr = new Date().toLocaleDateString("en-CA");

    // Scheduled blocks on TODAY's timeline. Completed tasks stay (rendered as
    // done) so a finished block is visibly marked rather than vanishing; tasks
    // deferred to another day fall out of this set entirely.
    const scheduledTasks: ScheduledTask[] = rawTasks.filter(
        (t): t is ScheduledTask =>
            typeof t.scheduledStart === "string" &&
            typeof t.scheduledEnd === "string" &&
            localDateStr(t.scheduledStart) === todayStr
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

    const updateMutation = useUpdateAssistantTaskMutation();

    function updateTaskTitle(id: string, title: string) {
        return updateMutation.mutateAsync({ id, data: { title } });
    }

    function setTaskCompleted(id: string, completed: boolean) {
        return updateMutation.mutateAsync({
            id,
            data: {
                status: completed ? "completed" : "in-progress",
                completedAt: completed ? new Date().toISOString() : null,
            },
        });
    }

    function deferTaskToTomorrow(task: AssistantTask) {
        if (!task.scheduledStart || !task.scheduledEnd) {
            return Promise.reject(new Error("Task is not scheduled"));
        }

        return rescheduleMutation.mutateAsync({
            id: task.id,
            scheduledStart: shiftToTomorrow(task.scheduledStart),
            scheduledEnd: shiftToTomorrow(task.scheduledEnd),
        });
    }

    const deleteMutation = useDeleteAssistantTaskMutation();

    function deleteTask(id: string) {
        if (!userId) {
            return Promise.reject(new Error("No user"));
        }

        return deleteMutation.mutateAsync({ id, userId });
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
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowDateStr = tomorrowDate.toLocaleDateString("en-CA");

    const completedToday: number = rawTasks.filter(
        (t) =>
            t.status === "completed" &&
            t.completedAt !== null &&
            t.completedAt !== undefined &&
            new Date(t.completedAt).toLocaleDateString("en-CA") === todayStr
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
        updateTaskTitle,
        setTaskCompleted,
        deferTaskToTomorrow,
        deleteTask,
        createTask,
        isCreating: createMutation.isPending,
        isRescheduling: rescheduleMutation.isPending,
        isMutating: updateMutation.isPending || deleteMutation.isPending || rescheduleMutation.isPending,
        // New
        focusSessions,
        completedToday,
        deferredToTomorrow,
    };
}
