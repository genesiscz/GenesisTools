import { getConfig } from "@app/dev-dashboard/config";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { findPublishedBySlug, listPublished } from "@app/dev-dashboard/lib/obsidian/publish";
import { readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import { renderSharePage } from "@app/dev-dashboard/lib/obsidian/share-template";
import type { RouteDef, RouteResult } from "@app/dev-dashboard/server/types";

const NOT_FOUND_HTML = "<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>";

export function shareRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/share/:slug",
            handler: async (ctx): Promise<RouteResult> => {
                const slug = ctx.params.slug;

                try {
                    const note = await findPublishedBySlug(slug);

                    if (!note) {
                        return {
                            kind: "raw",
                            status: 404,
                            contentType: "text/html; charset=utf-8",
                            body: NOT_FOUND_HTML,
                        };
                    }

                    const { obsidianVault } = await getConfig();

                    if (!obsidianVault) {
                        return {
                            kind: "text",
                            status: 500,
                            contentType: "text/plain; charset=utf-8",
                            body: "obsidian vault not configured",
                        };
                    }

                    const source = await readNote(obsidianVault, note.vaultPath);
                    const published = await listPublished();
                    const rendered = renderMarkdown(source, {
                        resolveWikilink: (name) => {
                            const match = published.find((publishedNote) => {
                                const base = publishedNote.vaultPath.split("/").pop() ?? publishedNote.vaultPath;

                                return base.replace(/\.md$/, "") === name;
                            });

                            return match?.slug ?? null;
                        },
                    });
                    const title = (note.vaultPath.split("/").pop() ?? note.vaultPath).replace(/\.md$/, "");
                    const page = renderSharePage({ title, rendered, sourcePath: note.vaultPath });

                    return {
                        kind: "raw",
                        status: 200,
                        contentType: "text/html; charset=utf-8",
                        headers: { "Cache-Control": "no-store" },
                        body: page,
                    };
                } catch (err) {
                    return {
                        kind: "text",
                        status: 500,
                        contentType: "text/plain; charset=utf-8",
                        body: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        },
    ];
}
