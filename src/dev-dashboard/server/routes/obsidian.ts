import { getConfig } from "@app/dev-dashboard/config";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { listPublished, publishNote, unpublishNote } from "@app/dev-dashboard/lib/obsidian/publish";
import { listVault, mkdirInVault, readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { resolveWikilinkToVaultPath } from "@app/utils/obsidian/wikilink-resolve";

export function obsidianRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/obsidian/tree",
            handler: async () => {
                try {
                    const { obsidianVault } = await getConfig();

                    if (!obsidianVault) {
                        return { kind: "json", status: 500, body: { error: "obsidian vault not configured" } };
                    }

                    const entries = await listVault(obsidianVault);

                    return { kind: "json", status: 200, body: { entries } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/obsidian/mkdir",
            handler: async (ctx) => {
                try {
                    const { relativeDir } = await ctx.readJson<{ relativeDir?: string }>();

                    if (!relativeDir?.trim()) {
                        return { kind: "json", status: 400, body: { error: "relativeDir required" } };
                    }

                    const { obsidianVault } = await getConfig();

                    if (!obsidianVault) {
                        return { kind: "json", status: 500, body: { error: "obsidian vault not configured" } };
                    }

                    await mkdirInVault(obsidianVault, relativeDir.trim());

                    return { kind: "json", status: 200, body: { ok: true, relativeDir: relativeDir.trim() } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/obsidian/note",
            handler: async (ctx) => {
                const path = ctx.query.get("path");

                if (!path) {
                    return { kind: "json", status: 400, body: { error: "missing ?path=" } };
                }

                try {
                    const { obsidianVault } = await getConfig();

                    if (!obsidianVault) {
                        return { kind: "json", status: 500, body: { error: "obsidian vault not configured" } };
                    }

                    const source = await readNote(obsidianVault, path);
                    const vaultEntries = await listVault(obsidianVault);
                    const published = await listPublished();
                    const publishedSlug = published.find((note) => note.vaultPath === path)?.slug ?? null;
                    const rendered = renderMarkdown(source, {
                        resolveWikilink: (name) => {
                            const match = published.find((note) => {
                                const base = note.vaultPath.split("/").pop() ?? note.vaultPath;

                                return base.replace(/\.md$/, "") === name;
                            });

                            return match?.slug ?? null;
                        },
                        resolveVaultNotePath: (name) => resolveWikilinkToVaultPath(vaultEntries, name, path),
                    });

                    return { kind: "json", status: 200, body: { source, html: rendered.html, publishedSlug } };
                } catch (err) {
                    return errorResult(err, 404);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/obsidian/publish",
            handler: async (ctx) => {
                try {
                    const { path } = await ctx.readJson<{ path: string }>();
                    const note = await publishNote(path);

                    return { kind: "json", status: 200, body: { note } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/obsidian/unpublish",
            handler: async (ctx) => {
                try {
                    const { slug } = await ctx.readJson<{ slug: string }>();
                    await unpublishNote(slug);
                    const remaining = await listPublished();

                    return { kind: "json", status: 200, body: { remaining } };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
