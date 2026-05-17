import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq } from "drizzle-orm";
import { type AiConversation, type AiMessage, aiConversations, aiMessages, db } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

// ============================================
// Conversations
// ============================================

export const listConversations = createServerFn({ method: "GET" }).handler(async (): Promise<AiConversation[]> => {
    const userId = await requireUserId();

    try {
        return db
            .select()
            .from(aiConversations)
            .where(eq(aiConversations.userId, userId))
            .orderBy(desc(aiConversations.updatedAt))
            .all();
    } catch (error) {
        console.error("[ai] listConversations failed:", error);
        throw error;
    }
});

export const createConversation = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; title: string }) => d)
    .handler(async ({ data }): Promise<AiConversation> => {
        const userId = await requireUserId();
        const now = new Date().toISOString();

        try {
            db.insert(aiConversations)
                .values({
                    id: data.id,
                    userId,
                    title: data.title,
                    createdAt: now,
                    updatedAt: now,
                })
                .run();

            const row = db.select().from(aiConversations).where(eq(aiConversations.id, data.id)).get();

            if (!row) {
                throw new Error("Row not found after insert");
            }

            emitDomainEvent(userId, "ai", { type: "conversation_changed" });

            return row;
        } catch (error) {
            console.error("[ai] createConversation failed:", error);
            throw error;
        }
    });

export const deleteConversation = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: true }> => {
        const userId = await requireUserId();

        try {
            const conv = db
                .select({ userId: aiConversations.userId })
                .from(aiConversations)
                .where(eq(aiConversations.id, data.id))
                .get();

            if (!conv || conv.userId !== userId) {
                throw new Response("Forbidden", { status: 403 });
            }

            db.transaction((tx) => {
                tx.delete(aiMessages)
                    .where(and(eq(aiMessages.conversationId, data.id), eq(aiMessages.userId, userId)))
                    .run();
                tx.delete(aiConversations)
                    .where(and(eq(aiConversations.id, data.id), eq(aiConversations.userId, userId)))
                    .run();
            });

            emitDomainEvent(userId, "ai", { type: "conversation_changed" });

            return { success: true };
        } catch (error) {
            if (error instanceof Response) {
                throw error;
            }

            console.error("[ai] deleteConversation failed:", error);
            throw error;
        }
    });

export const updateConversationTitle = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; title: string }) => d)
    .handler(async ({ data }): Promise<{ success: true }> => {
        const userId = await requireUserId();

        try {
            db.update(aiConversations)
                .set({ title: data.title, updatedAt: new Date().toISOString() })
                .where(and(eq(aiConversations.id, data.id), eq(aiConversations.userId, userId)))
                .run();

            emitDomainEvent(userId, "ai", { type: "conversation_changed" });

            return { success: true };
        } catch (error) {
            console.error("[ai] updateConversationTitle failed:", error);
            throw error;
        }
    });

// ============================================
// Messages
// ============================================

export const listMessages = createServerFn({ method: "GET" })
    .inputValidator((d: { conversationId: string }) => d)
    .handler(async ({ data }): Promise<AiMessage[]> => {
        const userId = await requireUserId();

        const conv = db
            .select({ userId: aiConversations.userId })
            .from(aiConversations)
            .where(eq(aiConversations.id, data.conversationId))
            .get();

        if (!conv || conv.userId !== userId) {
            throw new Response("Forbidden", { status: 403 });
        }

        try {
            return db
                .select()
                .from(aiMessages)
                .where(and(eq(aiMessages.conversationId, data.conversationId), eq(aiMessages.userId, userId)))
                .orderBy(asc(aiMessages.createdAt))
                .all();
        } catch (error) {
            console.error("[ai] listMessages failed:", error);
            throw error;
        }
    });

export const appendMessage = createServerFn({ method: "POST" })
    .inputValidator(
        (d: { id: string; conversationId: string; role: "user" | "assistant" | "system"; content: string }) => d
    )
    .handler(async ({ data }): Promise<AiMessage> => {
        const userId = await requireUserId();

        const conv = db
            .select({ userId: aiConversations.userId })
            .from(aiConversations)
            .where(eq(aiConversations.id, data.conversationId))
            .get();

        if (!conv || conv.userId !== userId) {
            throw new Response("Forbidden", { status: 403 });
        }

        const now = new Date().toISOString();

        try {
            db.insert(aiMessages)
                .values({
                    id: data.id,
                    userId,
                    conversationId: data.conversationId,
                    role: data.role,
                    content: data.content,
                    createdAt: now,
                })
                .run();

            // Bump conversation updatedAt so it floats to top of list
            db.update(aiConversations)
                .set({ updatedAt: now })
                .where(and(eq(aiConversations.id, data.conversationId), eq(aiConversations.userId, userId)))
                .run();

            const row = db.select().from(aiMessages).where(eq(aiMessages.id, data.id)).get();

            if (!row) {
                throw new Error("Row not found after insert");
            }

            emitDomainEvent(userId, "ai", { type: "conversation_changed" });

            return row;
        } catch (error) {
            console.error("[ai] appendMessage failed:", error);
            throw error;
        }
    });
