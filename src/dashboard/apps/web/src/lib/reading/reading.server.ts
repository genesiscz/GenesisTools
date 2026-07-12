import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq } from "drizzle-orm";
import {
    db,
    type NewReadingHighlight,
    type NewReadingItem,
    type ReadingHighlight,
    type ReadingItem,
    readingHighlights,
    readingItems,
} from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";

export type ReadingItemRow = Omit<ReadingItem, "tags"> & { tags: string[] };
export type ReadingHighlightRow = ReadingHighlight;

function toReadingItemRow(item: ReadingItem): ReadingItemRow {
    return {
        ...item,
        tags: item.tags ?? [],
    };
}

// ============================================
// Items — List
// ============================================

export const listReadingItems = createServerFn({ method: "GET" }).handler(async (): Promise<ReadingItemRow[]> => {
    const userId = await requireUserId();
    try {
        const rows = db
            .select()
            .from(readingItems)
            .where(eq(readingItems.userId, userId))
            .orderBy(desc(readingItems.updatedAt))
            .all();
        return rows.map(toReadingItemRow);
    } catch (err) {
        console.error("[reading] listReadingItems failed:", err);
        throw err;
    }
});

// ============================================
// Items — Create
// ============================================

export const createReadingItem = createServerFn({ method: "POST" })
    .inputValidator((d: Omit<NewReadingItem, "userId">) => d)
    .handler(async ({ data }): Promise<ReadingItemRow> => {
        const userId = await requireUserId();
        try {
            db.insert(readingItems)
                .values({ ...data, userId })
                .run();
            const created = db.select().from(readingItems).where(eq(readingItems.id, data.id)).get();
            if (!created) {
                throw new Error("[reading] createReadingItem: item not found after insert");
            }

            emitDomainEvent(userId, "reading", { type: "created" });

            return toReadingItemRow(created);
        } catch (err) {
            console.error("[reading] createReadingItem failed:", err);
            throw err;
        }
    });

// ============================================
// Items — Update (status / page / rating / fields)
// ============================================

type ReadingItemPatch = Partial<
    Pick<
        ReadingItem,
        "title" | "author" | "type" | "url" | "coverUrl" | "status" | "currentPage" | "totalPages" | "rating" | "tags"
    >
>;

export const updateReadingItem = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; patch: ReadingItemPatch }) => d)
    .handler(async ({ data }): Promise<ReadingItemRow> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            db.update(readingItems)
                .set({ ...data.patch, updatedAt: now })
                .where(and(eq(readingItems.id, data.id), eq(readingItems.userId, userId)))
                .run();
            const updated = db.select().from(readingItems).where(eq(readingItems.id, data.id)).get();
            if (!updated) {
                throw new Error(`[reading] updateReadingItem: item ${data.id} not found after update`);
            }

            emitDomainEvent(userId, "reading", { type: "updated" });

            return toReadingItemRow(updated);
        } catch (err) {
            console.error("[reading] updateReadingItem failed:", err);
            throw err;
        }
    });

// ============================================
// Items — Delete
// ============================================

export const deleteReadingItem = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.delete(readingHighlights)
                .where(and(eq(readingHighlights.itemId, data.id), eq(readingHighlights.userId, userId)))
                .run();
            db.delete(readingItems)
                .where(and(eq(readingItems.id, data.id), eq(readingItems.userId, userId)))
                .run();

            emitDomainEvent(userId, "reading", { type: "deleted" });

            return { success: true };
        } catch (err) {
            console.error("[reading] deleteReadingItem failed:", err);
            throw err;
        }
    });

// ============================================
// Highlights — List (per item)
// ============================================

export const listReadingHighlights = createServerFn({ method: "GET" })
    .inputValidator((d: { itemId: string }) => d)
    .handler(async ({ data }): Promise<ReadingHighlightRow[]> => {
        const userId = await requireUserId();
        try {
            return db
                .select()
                .from(readingHighlights)
                .where(and(eq(readingHighlights.itemId, data.itemId), eq(readingHighlights.userId, userId)))
                .orderBy(asc(readingHighlights.createdAt))
                .all();
        } catch (err) {
            console.error("[reading] listReadingHighlights failed:", err);
            throw err;
        }
    });

// ============================================
// Highlights — Create
// ============================================

export const createReadingHighlight = createServerFn({ method: "POST" })
    .inputValidator((d: Omit<NewReadingHighlight, "userId">) => d)
    .handler(async ({ data }): Promise<ReadingHighlightRow> => {
        const userId = await requireUserId();
        try {
            db.insert(readingHighlights)
                .values({ ...data, userId })
                .run();
            const created = db.select().from(readingHighlights).where(eq(readingHighlights.id, data.id)).get();
            if (!created) {
                throw new Error("[reading] createReadingHighlight: highlight not found after insert");
            }

            emitDomainEvent(userId, "reading", { type: "highlight-created" });

            return created;
        } catch (err) {
            console.error("[reading] createReadingHighlight failed:", err);
            throw err;
        }
    });

// ============================================
// Highlights — Delete
// ============================================

export const deleteReadingHighlight = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.delete(readingHighlights)
                .where(and(eq(readingHighlights.id, data.id), eq(readingHighlights.userId, userId)))
                .run();

            emitDomainEvent(userId, "reading", { type: "highlight-deleted" });

            return { success: true };
        } catch (err) {
            console.error("[reading] deleteReadingHighlight failed:", err);
            throw err;
        }
    });
