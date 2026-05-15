import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import type { AssistantTask } from "@/drizzle";
import { assistantKeys, useAssistantTasksQuery } from "@/lib/assistant/hooks/useAssistantQueries";
import { rescheduleTask } from "@/lib/assistant/planner.server";
import { ASSISTANT_SYNC_CHANNEL, broadcastInvalidate } from "@/lib/sync/useBroadcastInvalidation";

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

    return {
        userId,
        isLoading: tasksQuery.isLoading,
        error: tasksQuery.error,
        scheduledTasks,
        unscheduledTasks,
        allActiveTasks: rawTasks.filter((t) => t.status !== "completed"),
        scheduleTask,
        unscheduleTask,
        isRescheduling: rescheduleMutation.isPending,
    };
}
