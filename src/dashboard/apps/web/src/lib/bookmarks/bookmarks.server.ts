import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { type Bookmark, bookmarks, db, type NewBookmark } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";
import { fetchPublicUrlMetadata } from "./fetch-metadata";
import type { UrlMetadata } from "./metadata";

// ============================================
// Types
// ============================================

/** Narrowed return type — tags are always string[], dates are ISO strings. */
export type BookmarkRow = Omit<Bookmark, "tags"> & { tags: string[] };

function toBookmarkRow(b: Bookmark): BookmarkRow {
    return {
        ...b,
        tags: b.tags ?? [],
    };
}

// ============================================
// List
// ============================================

export const listBookmarks = createServerFn({ method: "GET" }).handler(async (): Promise<BookmarkRow[]> => {
    const userId = await requireUserId();
    try {
        const rows = db
            .select()
            .from(bookmarks)
            .where(eq(bookmarks.userId, userId))
            .orderBy(desc(bookmarks.createdAt))
            .all();
        return rows.map(toBookmarkRow);
    } catch (err) {
        console.error("[bookmarks] listBookmarks failed:", err);
        throw err;
    }
});

// ============================================
// Create
// ============================================

export const createBookmark = createServerFn({ method: "POST" })
    .inputValidator((d: Omit<NewBookmark, "userId">) => d)
    .handler(async ({ data }): Promise<BookmarkRow> => {
        const userId = await requireUserId();
        try {
            db.insert(bookmarks)
                .values({ ...data, userId })
                .run();
            const created = db.select().from(bookmarks).where(eq(bookmarks.id, data.id)).get();
            if (!created) {
                throw new Error("[bookmarks] createBookmark: bookmark not found after insert");
            }

            emitDomainEvent(userId, "bookmarks", { type: "created" });

            return toBookmarkRow(created);
        } catch (err) {
            console.error("[bookmarks] createBookmark failed:", err);
            throw err;
        }
    });

// ============================================
// Update
// ============================================

export const updateBookmark = createServerFn({ method: "POST" })
    .inputValidator(
        (d: { id: string; patch: Partial<Pick<Bookmark, "title" | "description" | "faviconUrl" | "tags" | "url">> }) =>
            d
    )
    .handler(async ({ data }): Promise<BookmarkRow> => {
        const userId = await requireUserId();
        try {
            const now = new Date().toISOString();
            db.update(bookmarks)
                .set({ ...data.patch, updatedAt: now })
                .where(and(eq(bookmarks.id, data.id), eq(bookmarks.userId, userId)))
                .run();
            const updated = db.select().from(bookmarks).where(eq(bookmarks.id, data.id)).get();
            if (!updated) {
                throw new Error(`[bookmarks] updateBookmark: bookmark ${data.id} not found after update`);
            }

            emitDomainEvent(userId, "bookmarks", { type: "updated" });

            return toBookmarkRow(updated);
        } catch (err) {
            console.error("[bookmarks] updateBookmark failed:", err);
            throw err;
        }
    });

// ============================================
// Delete
// ============================================

export const deleteBookmark = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        const userId = await requireUserId();
        try {
            db.delete(bookmarks)
                .where(and(eq(bookmarks.id, data.id), eq(bookmarks.userId, userId)))
                .run();

            emitDomainEvent(userId, "bookmarks", { type: "deleted" });

            return { success: true };
        } catch (err) {
            console.error("[bookmarks] deleteBookmark failed:", err);
            throw err;
        }
    });

// ============================================
// fetchUrlMetadata — server-side URL scrape
// ============================================

export const fetchUrlMetadata = createServerFn({ method: "POST" })
    .inputValidator((d: { url: string }) => d)
    .handler(async ({ data }): Promise<UrlMetadata> => {
        await requireUserId();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);

        try {
            return await fetchPublicUrlMetadata({ target: data.url, signal: controller.signal });
        } catch (err) {
            console.error("[bookmarks] fetchUrlMetadata failed:", err);
            throw err;
        } finally {
            clearTimeout(timer);
        }
    });
