import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { assistantTasks, db } from "@/drizzle";

export interface RescheduleTaskInput {
    id: string;
    scheduledStart: string | null;
    scheduledEnd: string | null;
}

export const rescheduleTask = createServerFn({ method: "POST" })
    .inputValidator((d: RescheduleTaskInput) => d)
    .handler(({ data }) => {
        db.update(assistantTasks)
            .set({
                scheduledStart: data.scheduledStart,
                scheduledEnd: data.scheduledEnd,
            })
            .where(eq(assistantTasks.id, data.id))
            .run();

        return { success: true };
    });
