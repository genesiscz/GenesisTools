import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { type Bookmark, bookmarks, db, type NewBookmark } from "@/drizzle";
import { requireUserId } from "@/lib/auth/requireUser";
import { emitDomainEvent } from "@/lib/events/event-bus.server";
import { extractHtmlMetadata, type UrlMetadata } from "./metadata";

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

/** Private IPs / localhost patterns to block (SSRF guard). */
const PRIVATE_HOST_RE =
    /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/i;

function assertSafeUrl(raw: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`Invalid URL: ${raw}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Only http/https URLs are allowed. Got: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname;
    if (PRIVATE_HOST_RE.test(hostname)) {
        throw new Error(`Blocked private/localhost URL: ${hostname}`);
    }

    return parsed;
}

export const fetchUrlMetadata = createServerFn({ method: "POST" })
    .inputValidator((d: { url: string }) => d)
    .handler(async ({ data }): Promise<UrlMetadata> => {
        await requireUserId();
        const parsed = assertSafeUrl(data.url);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);

        try {
            // Re-validate every redirect hop: assertSafeUrl only checked the
            // initial URL; a 30x to localhost / 169.254.169.254 would otherwise
            // bypass the SSRF guard. redirect:"manual" + bounded hop loop.
            let currentUrl = parsed.href;
            let response: Response;
            const MAX_HOPS = 5;
            for (let hop = 0; ; hop++) {
                response = await fetch(currentUrl, {
                    signal: controller.signal,
                    redirect: "manual",
                    headers: {
                        "User-Agent": "GenesisTools-Dashboard/1.0 (bookmark-metadata-fetcher)",
                        Accept: "text/html,application/xhtml+xml",
                    },
                });

                if (response.status >= 300 && response.status < 400) {
                    const loc = response.headers.get("location");
                    if (!loc) {
                        break;
                    }

                    if (hop >= MAX_HOPS) {
                        throw new Error(`Too many redirects fetching ${parsed.href}`);
                    }

                    currentUrl = assertSafeUrl(new URL(loc, currentUrl).href).href;
                    continue;
                }

                break;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} fetching ${parsed.href}`);
            }

            // Read only the first 64 KB — enough to cover <head>
            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("Response body is null");
            }

            const decoder = new TextDecoder();
            let html = "";
            let bytesRead = 0;
            const MAX_BYTES = 64 * 1024;

            while (bytesRead < MAX_BYTES) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                html += decoder.decode(value, { stream: true });
                bytesRead += value.byteLength;
            }
            reader.cancel();

            const metadata = extractHtmlMetadata(html, parsed.href);
            return metadata;
        } catch (err) {
            console.error("[bookmarks] fetchUrlMetadata failed:", err);
            throw err;
        } finally {
            clearTimeout(timer);
        }
    });
