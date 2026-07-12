import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { type AssistantBlocker, assistantBlockers, db } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";

export const deleteAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();

        try {
            db.delete(assistantBlockers)
                .where(and(eq(assistantBlockers.id, data.id), eq(assistantBlockers.userId, userId)))
                .run();
            return { success: true };
        } catch (error) {
            console.error("[Assistant] deleteAssistantBlocker error:", error);
            throw error;
        }
    });

export const reopenAssistantBlocker = createServerFn({
    method: "POST",
})
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<AssistantBlocker | null> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(assistantBlockers)
                .set({
                    unblockedAt: null,
                    updatedAt: new Date().toISOString(),
                })
                .where(and(eq(assistantBlockers.id, data.id), eq(assistantBlockers.userId, userId)))
                .returning()
                .get();

            return result ?? null;
        } catch (error) {
            console.error("[Assistant] reopenAssistantBlocker error:", error);
            throw error;
        }
    });
