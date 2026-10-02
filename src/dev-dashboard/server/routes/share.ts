import { getConfig } from "@app/dev-dashboard/config";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { findPublishedBySlug, listPublished } from "@app/dev-dashboard/lib/obsidian/publish";
import { readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import {
    buildShareAssetIndex,
    codeLanguageFor,
    fencedCode,
    hashAsset,
    lineRangeOf,
    readShareAsset,
    renderCodeAssetHtml,
    renderJsonAssetHtml,
    renderMarkdownAssetHtml,
    SHARE_ASSET_HASH_RE,
    type ShareAsset,
    type ShareAssetIndex,
    shareAssetUrl,
} from "@app/dev-dashboard/lib/obsidian/share-assets";
import { renderSharePage } from "@app/dev-dashboard/lib/obsidian/share-template";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { redactSecretsInText } from "@genesiscz/utils/transclude";

const NOT_FOUND_HTML = "<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>";
const ASSET_CACHE_LIMIT = 64;

const NOT_FOUND: RouteResult = {
    kind: "raw",
    status: 404,
    contentType: "text/html; charset=utf-8",
    body: NOT_FOUND_HTML,
};

// A served asset never runs anything: an SVG opened directly is sandboxed and may load nothing,
// and the hash in the URL names the content, so the bytes behind it never change.
const ASSET_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * Keyed by slug; an entry is reused only while the note's text hashes the same and for at most
 * `ASSET_INDEX_TTL_MS`: an edited or newly added attachment gets its new hash URL on the next page
 * load after that, never only after a 404 on the old URL.
 */
const assetIndexCache = new Map<string, { sourceHash: string; builtAt: number; index: ShareAssetIndex }>();
const ASSET_INDEX_TTL_MS = 30_000;

async function assetIndexFor(options: {
    slug: string;
    vaultRoot: string;
    notePath: string;
    source: string;
}): Promise<ShareAssetIndex> {
    const { slug, vaultRoot, notePath, source } = options;
    const sourceHash = hashAsset(new TextEncoder().encode(`${notePath}\n${source}`));
    const cached = assetIndexCache.get(slug);

    if (cached?.sourceHash === sourceHash && Date.now() - cached.builtAt < ASSET_INDEX_TTL_MS) {
        return cached.index;
    }

    const index = await buildShareAssetIndex({ vaultRoot, notePath, source });

    assetIndexCache.delete(slug);
    assetIndexCache.set(slug, { sourceHash, builtAt: Date.now(), index });

    if (assetIndexCache.size > ASSET_CACHE_LIMIT) {
        const oldest = assetIndexCache.keys().next().value;

        if (oldest !== undefined) {
            assetIndexCache.delete(oldest);
        }
    }

    return index;
}

const LINES_PARAM_RE = /^(\d{1,7})(?:-(\d{1,7}))?$/;

function renderAssetFragment(asset: ShareAsset, text: string, linesParam: string | null): string {
    if (asset.kind === "json") {
        return renderJsonAssetHtml(text);
    }

    if (asset.kind === "markdown") {
        return renderMarkdownAssetHtml(text);
    }

    const match = linesParam ? LINES_PARAM_RE.exec(linesParam) : null;
    const lines = match
        ? { start: Number(match[1]), end: Math.max(Number(match[1]), Number(match[2] ?? match[1])) }
        : null;

    return renderCodeAssetHtml({ text, language: asset.language ?? "plaintext", lines });
}

function wantsHtml(ctx: RouteContext): boolean {
    const accept = ctx.headers.accept ?? "";

    return accept.includes("text/html") && !accept.includes("application/json");
}

export function shareRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/share/:slug",
            handler: async (ctx): Promise<RouteResult> => {
                const slug = ctx.params.slug;

                try {
                    const requestedHash = ctx.query.get("asset");

                    if (requestedHash !== null && !SHARE_ASSET_HASH_RE.test(requestedHash)) {
                        return NOT_FOUND;
                    }

                    const note = await findPublishedBySlug(slug);

                    if (!note) {
                        return NOT_FOUND;
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

                    // The page is public: the rendered note, its source view and its download all use the masked text.
                    const source = redactSecretsInText(await readNote(obsidianVault, note.vaultPath));
                    // A shared source file is one highlighted block. Its comments are not markdown, so
                    // nothing in them becomes a link or an asset the page would serve.
                    const language = codeLanguageFor(note.vaultPath);
                    const markdown = language ? fencedCode(source, language) : source;
                    const assets = await assetIndexFor({
                        slug,
                        vaultRoot: obsidianVault,
                        notePath: note.vaultPath,
                        source: markdown,
                    });
                    let openAssetUrl: string | undefined;

                    if (requestedHash !== null) {
                        const found = await readShareAsset({
                            vaultRoot: obsidianVault,
                            index: assets,
                            hash: requestedHash,
                        });

                        if (!found) {
                            // A known hash that no longer matches its file means the file changed; rebuild next time.
                            // Unknown hashes leave the cache alone, so guessing cannot force a rebuild per request.
                            if (assets.byHash.has(requestedHash)) {
                                assetIndexCache.delete(slug);
                            }

                            return NOT_FOUND;
                        }

                        const { asset, body } = found;
                        const url = shareAssetUrl(slug, asset.hash);

                        const view = ctx.query.get("view");

                        if (asset.kind !== "image" && view === "fragment") {
                            return {
                                kind: "raw",
                                status: 200,
                                contentType: "text/html; charset=utf-8",
                                headers: ASSET_HEADERS,
                                body: renderAssetFragment(asset, body.toString("utf8"), ctx.query.get("lines")),
                            };
                        }

                        if (asset.kind === "image" || view === "raw" || !wantsHtml(ctx)) {
                            return {
                                kind: "binary",
                                status: 200,
                                contentType: asset.contentType,
                                body,
                                headers: {
                                    ...ASSET_HEADERS,
                                    Vary: "Accept",
                                    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
                                },
                            };
                        }

                        openAssetUrl = url;
                    }

                    const published = await listPublished();
                    const publishedByPath = new Map(published.map((entry) => [entry.vaultPath, entry.slug]));
                    const rendered = renderMarkdown(markdown, {
                        resolveWikilink: (name) => {
                            const match = published.find((publishedNote) => {
                                const base = publishedNote.vaultPath.split("/").pop() ?? publishedNote.vaultPath;

                                return base.replace(/\.md$/, "") === name;
                            });

                            return match?.slug ?? null;
                        },
                        resolveAsset: (target) => {
                            const asset = assets.byTarget.get(target);

                            if (!asset) {
                                return null;
                            }

                            const publishedSlug =
                                asset.kind === "markdown" ? publishedByPath.get(asset.vaultPath) : undefined;

                            if (publishedSlug) {
                                return {
                                    url: `/share/${encodeURIComponent(publishedSlug)}`,
                                    kind: "page",
                                    name: asset.name,
                                };
                            }

                            const range = lineRangeOf(target);
                            const fragment = range
                                ? `#L${range.start}${range.end > range.start ? `-L${range.end}` : ""}`
                                : "";

                            return {
                                url: `${shareAssetUrl(slug, asset.hash)}${fragment}`,
                                kind: asset.kind,
                                name: asset.name,
                            };
                        },
                    });
                    const title = (note.vaultPath.split("/").pop() ?? note.vaultPath).replace(/\.md$/, "");
                    const page = renderSharePage({ title, rendered, source, sourcePath: note.vaultPath, openAssetUrl });

                    return {
                        kind: "raw",
                        status: 200,
                        contentType: "text/html; charset=utf-8",
                        headers: { "Cache-Control": "no-store", Vary: "Accept" },
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
