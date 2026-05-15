import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { db, type NewNote, type Note, notes } from "@/drizzle";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

// ============================================
// List
// ============================================

export const listNotes = createServerFn({ method: "GET" })
    .inputValidator((d: { userId: string }) => d)
    .handler(({ data }): Note[] => {
        try {
            return db
                .select()
                .from(notes)
                .where(eq(notes.userId, data.userId))
                .orderBy(desc(notes.pinned), desc(notes.updatedAt))
                .all();
        } catch (err) {
            console.error("[notes] listNotes failed:", err);
            throw err;
        }
    });

// ============================================
// Get single
// ============================================

export const getNote = createServerFn({ method: "GET" })
    .inputValidator((d: { id: string }) => d)
    .handler(({ data }): Note | null => {
        try {
            return db.select().from(notes).where(eq(notes.id, data.id)).get() ?? null;
        } catch (err) {
            console.error("[notes] getNote failed:", err);
            throw err;
        }
    });

// ============================================
// Create
// ============================================

export const createNote = createServerFn({ method: "POST" })
    .inputValidator(
        (d: { userId: string; title: string; body?: string; tags?: string[]; pinned?: number }) => d
    )
    .handler(({ data }): Note => {
        try {
            const now = new Date().toISOString();
            const newNote: NewNote = {
                id: crypto.randomUUID(),
                userId: data.userId,
                title: data.title,
                body: data.body ?? "",
                tags: data.tags ?? [],
                pinned: data.pinned ?? 0,
                createdAt: now,
                updatedAt: now,
            };

            const result = db.insert(notes).values(newNote).returning().get();

            if (!result) {
                throw new Error("[notes] createNote: insert returned no result");
            }

            emitDomainEvent(data.userId, "notes", { type: "created" });

            return result;
        } catch (err) {
            console.error("[notes] createNote failed:", err);
            throw err;
        }
    });
