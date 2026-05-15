import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq } from "drizzle-orm";
import { type AiConversation, type AiMessage, aiConversations, aiMessages, db } from "@/drizzle";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

// ============================================
// Conversations
// ============================================

export const listConversations = createServerFn({ method: "GET" })
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): AiConversation[] => {
        try {
            return db
                .select()
                .from(aiConversations)
                .where(eq(aiConversations.userId, data.userId))
                .orderBy(desc(aiConversations.updatedAt))
                .all();
        } catch (error) {
            console.error("[ai] listConversations failed:", error);
            throw error;
        }
    });

export const createConversation = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; title: string }) => d)
    .handler(({ data }): AiConversation => {
        const now = new Date().toISOString();

        try {
            db.insert(aiConversations)
                .values({
                    id: data.id,
                    userId: data.userId,
                    title: data.title,
                    createdAt: now,
                    updatedAt: now,
                })
                .run();

            const row = db.select().from(aiConversations).where(eq(aiConversations.id, data.id)).get();

            if (!row) {
                throw new Error("Row not found after insert");
            }

            emitDomainEvent(data.userId, "ai", { type: "conversation_changed" });

            return row;
        } catch (error) {
            console.error("[ai] createConversation failed:", error);
            throw error;
        }
    });

export const deleteConversation = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string }) => d)
    .handler(({ data }): { success: true } => {
        try {
            db.delete(aiMessages).where(eq(aiMessages.conversationId, data.id)).run();

            db.delete(aiConversations)
                .where(and(eq(aiConversations.id, data.id), eq(aiConversations.userId, data.userId)))
                .run();

            emitDomainEvent(data.userId, "ai", { type: "conversation_changed" });

            return { success: true };
        } catch (error) {
            console.error("[ai] deleteConversation failed:", error);
            throw error;
        }
    });

export const updateConversationTitle = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; userId: string; title: string }) => d)
    .handler(({ data }): { success: true } => {
        try {
            db.update(aiConversations)
                .set({ title: data.title, updatedAt: new Date().toISOString() })
                .where(and(eq(aiConversations.id, data.id), eq(aiConversations.userId, data.userId)))
                .run();

            emitDomainEvent(data.userId, "ai", { type: "conversation_changed" });

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
    .handler(({ data }): AiMessage[] => {
        try {
            return db
                .select()
                .from(aiMessages)
                .where(eq(aiMessages.conversationId, data.conversationId))
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
    .handler(({ data }): AiMessage => {
        const now = new Date().toISOString();

        try {
            db.insert(aiMessages)
                .values({
                    id: data.id,
                    conversationId: data.conversationId,
                    role: data.role,
                    content: data.content,
                    createdAt: now,
                })
                .run();

            // Bump conversation updatedAt so it floats to top of list
            db.update(aiConversations).set({ updatedAt: now }).where(eq(aiConversations.id, data.conversationId)).run();

            const row = db.select().from(aiMessages).where(eq(aiMessages.id, data.id)).get();

            if (!row) {
                throw new Error("Row not found after insert");
            }

            const conv = db
                .select({ userId: aiConversations.userId })
                .from(aiConversations)
                .where(eq(aiConversations.id, data.conversationId))
                .get();

            if (conv) {
                emitDomainEvent(conv.userId, "ai", { type: "conversation_changed" });
            }

            return row;
        } catch (error) {
            console.error("[ai] appendMessage failed:", error);
            throw error;
        }
    });
