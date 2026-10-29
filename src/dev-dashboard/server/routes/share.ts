import { getConfig } from "@app/dev-dashboard/config";
import { renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { findPublishedBySlug, listPublished } from "@app/dev-dashboard/lib/obsidian/publish";
import { readNote } from "@app/dev-dashboard/lib/obsidian/reader";
import {
    buildShareAssetIndex,
    buildShareBundle,
    buildShareEmbed,
    codeLanguageFor,
    fencedCode,
    hashAsset,
    isMediaKind,
    lineRangeOf,
    readShareAsset,
    renderShareAssetFragment,
    SHARE_ASSET_HASH_RE,
    type ShareAsset,
    type ShareAssetIndex,
    type ShareEmbed,
    shareAssetUrl,
} from "@app/dev-dashboard/lib/obsidian/share-assets";
import { renderSharePage } from "@app/dev-dashboard/lib/obsidian/share-template";
import { publicBaseUrl } from "@app/dev-dashboard/lib/public-base";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { zip } from "@genesiscz/utils/fs/zip";
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

function parseLinesParam(linesParam: string | null): { start: number; end: number } | null {
    const match = linesParam ? LINES_PARAM_RE.exec(linesParam) : null;

    return match ? { start: Number(match[1]), end: Math.max(Number(match[1]), Number(match[2] ?? match[1])) } : null;
}

const TOO_LARGE: RouteResult = {
    kind: "text",
    status: 413,
    contentType: "text/plain; charset=utf-8",
    body: "the note and its attachments are too large to download as one file",
};

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * An asset's bytes, or the one byte range asked for: Safari plays `<audio>` and `<video>` only from a server
 * that answers ranges. A PDF goes without the sandbox policy, because a sandboxed document cannot open the
 * browser's PDF viewer.
 */
function assetBytes(options: { asset: ShareAsset; body: Buffer; range: string | undefined }): RouteResult {
    const { asset, body, range } = options;
    const headers: Record<string, string> = {
        ...ASSET_HEADERS,
        ...(asset.kind === "pdf" ? { "Content-Security-Policy": "default-src 'none'; object-src 'self'" } : {}),
        Vary: "Accept",
        "Accept-Ranges": "bytes",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    };
    const match = range ? RANGE_RE.exec(range.trim()) : null;

    if (!match || (match[1] === "" && match[2] === "")) {
        return { kind: "binary", status: 200, contentType: asset.contentType, body, headers };
    }

    const size = body.length;
    // `bytes=-500` is the last 500 bytes.
    const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));

    if (start >= size || start > end) {
        return {
            kind: "binary",
            status: 416,
            contentType: asset.contentType,
            body: new Uint8Array(),
            headers: { ...headers, "Content-Range": `bytes */${size}` },
        };
    }

    return {
        kind: "binary",
        status: 206,
        contentType: asset.contentType,
        body: body.subarray(start, end + 1),
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` },
    };
}

function attachmentHeaders(fileName: string): Record<string, string> {
    return {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    };
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
                    const title = (note.vaultPath.split("/").pop() ?? note.vaultPath).replace(/\.md$/, "");
                    const fileBase = title.replace(/[\\/:*?"<>|]/g, "_") || "note";
                    const download = ctx.query.get("download");

                    if (download === "zip") {
                        const bundle = await buildShareBundle({
                            vaultRoot: obsidianVault,
                            index: assets,
                            notePath: note.vaultPath,
                            noteText: source,
                            folderName: fileBase,
                        });

                        if (!bundle) {
                            return TOO_LARGE;
                        }

                        return {
                            kind: "binary",
                            status: 200,
                            contentType: "application/zip",
                            body: zip(bundle.entries),
                            headers: attachmentHeaders(`${fileBase}.zip`),
                        };
                    }

                    // A saved page has no server behind it: images become data: URLs, panels are pre-rendered
                    // into the page, and links to other shared notes point at this dashboard's public address.
                    let embed: ShareEmbed | null = null;

                    if (download === "html") {
                        embed = await buildShareEmbed({
                            vaultRoot: obsidianVault,
                            index: assets,
                            panelBase: (hash) => `?asset=${hash}`,
                        });

                        if (!embed) {
                            return TOO_LARGE;
                        }
                    }

                    const pageBase = embed ? await publicBaseUrl() : "";

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

                        if (!isMediaKind(asset.kind) && view === "fragment") {
                            return {
                                kind: "raw",
                                status: 200,
                                contentType: "text/html; charset=utf-8",
                                headers: ASSET_HEADERS,
                                body: renderShareAssetFragment(
                                    asset,
                                    body.toString("utf8"),
                                    parseLinesParam(ctx.query.get("lines"))
                                ),
                            };
                        }

                        if (isMediaKind(asset.kind) || view === "raw" || !wantsHtml(ctx)) {
                            return assetBytes({ asset, body, range: ctx.headers.range });
                        }

                        openAssetUrl = url;
                    }

                    const published = await listPublished();
                    const publishedByPath = new Map(published.map((entry) => [entry.vaultPath, entry.slug]));
                    const rendered = renderMarkdown(markdown, {
                        pageBaseUrl: pageBase,
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
                                    url: `${pageBase}/share/${encodeURIComponent(publishedSlug)}`,
                                    kind: "page",
                                    name: asset.name,
                                };
                            }

                            const range = lineRangeOf(target);
                            const fragment = range
                                ? `#L${range.start}${range.end > range.start ? `-L${range.end}` : ""}`
                                : "";

                            if (embed && isMediaKind(asset.kind)) {
                                const inline = embed.media.get(asset.hash);

                                return inline ? { url: inline, kind: asset.kind, name: asset.name } : null;
                            }

                            const url = embed ? `?asset=${asset.hash}` : shareAssetUrl(slug, asset.hash);
                            // `doc.pdf#page=3&height=400` keeps its fragment for the PDF viewer and the frame height.
                            const pdfFragment = asset.kind === "pdf" ? (/#.*$/.exec(target)?.[0] ?? "") : "";

                            return { url: `${url}${fragment || pdfFragment}`, kind: asset.kind, name: asset.name };
                        },
                    });
                    const page = renderSharePage({
                        title,
                        rendered,
                        source,
                        sourcePath: note.vaultPath,
                        openAssetUrl,
                        attachmentCount: [...assets.byHash.values()].filter(
                            (asset) => asset.vaultPath !== note.vaultPath
                        ).length,
                        downloads: embed
                            ? undefined
                            : {
                                  zip: `/share/${encodeURIComponent(slug)}?download=zip`,
                                  html: `/share/${encodeURIComponent(slug)}?download=html`,
                              },
                        embeddedPanels: embed?.panels,
                    });

                    if (embed) {
                        return {
                            kind: "raw",
                            status: 200,
                            contentType: "text/html; charset=utf-8",
                            headers: attachmentHeaders(`${fileBase}.html`),
                            body: page,
                        };
                    }

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
