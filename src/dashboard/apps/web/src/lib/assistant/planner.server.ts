import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { assistantTasks, db } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";

export interface RescheduleTaskInput {
    id: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
}

export const rescheduleTask = createServerFn({ method: "POST" })
    .inputValidator((d: Omit<RescheduleTaskInput, "userId">) => d)
    .handler(async ({ data }) => {
        const userId = await requireUserId();

        db.update(assistantTasks)
            .set({
                scheduledStart: data.scheduledStart,
                scheduledEnd: data.scheduledEnd,
            })
            .where(and(eq(assistantTasks.id, data.id), eq(assistantTasks.userId, userId)))
            .run();

        return { success: true };
    });
