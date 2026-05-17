import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { db, type NewNote, type Note, notes } from "@/drizzle";
import { emitDomainEvent } from "@/lib/events/event-bus.server";
import { requireUserId } from "@/lib/auth/requireUser";

// ============================================
// List
// ============================================

export const listNotes = createServerFn({ method: "GET" })
    .handler(async (): Promise<Note[]> => {
        const userId = await requireUserId();

        try {
            return db
                .select()
                .from(notes)
                .where(eq(notes.userId, userId))
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
    .handler(async ({ data }): Promise<Note | null> => {
        const userId = await requireUserId();

        try {
            return (
                db
                    .select()
                    .from(notes)
                    .where(and(eq(notes.id, data.id), eq(notes.userId, userId)))
                    .get() ?? null
            );
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
        (d: { title: string; body?: string; tags?: string[]; pinned?: number }) => d,
    )
    .handler(async ({ data }): Promise<Note> => {
        const userId = await requireUserId();

        try {
            const now = new Date().toISOString();
            const newNote: NewNote = {
                id: crypto.randomUUID(),
                userId,
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

            emitDomainEvent(userId, "notes", { type: "created" });

            return result;
        } catch (err) {
            console.error("[notes] createNote failed:", err);
            throw err;
        }
    });

// ============================================
// Update
// ============================================

export const updateNote = createServerFn({ method: "POST" })
    .inputValidator(
        (d: { id: string; patch: Partial<Pick<NewNote, "title" | "body" | "tags" | "pinned">> }) => d,
    )
    .handler(async ({ data }): Promise<Note> => {
        const userId = await requireUserId();

        try {
            const result = db
                .update(notes)
                .set({ ...data.patch, updatedAt: new Date().toISOString() })
                .where(and(eq(notes.id, data.id), eq(notes.userId, userId)))
                .returning()
                .get();

            if (!result) {
                throw new Error(`[notes] updateNote: note ${data.id} not found`);
            }

            emitDomainEvent(userId, "notes", { type: "updated" });

            return result;
        } catch (err) {
            console.error("[notes] updateNote failed:", err);
            throw err;
        }
    });

// ============================================
// Delete
// ============================================

export const deleteNote = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();

        try {
            db.delete(notes)
                .where(and(eq(notes.id, data.id), eq(notes.userId, userId)))
                .run();

            emitDomainEvent(userId, "notes", { type: "deleted" });

            return { success: true };
        } catch (err) {
            console.error("[notes] deleteNote failed:", err);
            throw err;
        }
    });
