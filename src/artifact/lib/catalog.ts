import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canonicalDir, isInsideDir } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { Plugin } from "vite";
import { renderMarkdown } from "./markdown";
import { encodeHrefPath, escapeHtml, loadTemplate, loadThemeCss, renderTemplate, themeCssPath } from "./templates";
import { RUNTIME_DIR } from "./vite";

const TSX_ENTRY_PREFIX = "/__artifact-entry/";
const TSX_ENTRY_RESOLVED = "\0artifact-entry:";
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const MAX_SCAN_DEPTH = 4;

export interface ArtifactListing {
    html: string[];
    tsx: string[];
    md: string[];
}

/** List servable artifacts (relative POSIX paths) under `dir`, shallow-recursive. */
export function scanArtifacts(dir: string): ArtifactListing {
    const listing: ArtifactListing = { html: [], tsx: [], md: [] };
    const visitedDirs = new Set<string>([canonicalDir(dir)]);

    const walk = (current: string, depth: number): void => {
        for (const name of readdirSync(current)) {
            if (name.startsWith(".")) {
                continue;
            }

            const full = join(current, name);
            const link = lstatSync(full);

            // A symlink is followed only when its target still exists and stays
            // inside `dir`. The catalog must never advertise what safeResolve
            // would refuse to serve, and listing names alone already leaks them.
            if (link.isSymbolicLink() && (!existsSync(full) || !isInsideDir(dir, full))) {
                logger.debug({ dir, full }, "[artifact] skipping a symlink that leaves the served folder");

                continue;
            }

            const stat = link.isSymbolicLink() ? statSync(full) : link;

            if (stat.isDirectory()) {
                // A symlinked directory can alias an ancestor ("loop -> ."), which
                // would make this walk recurse forever. Each real directory is
                // descended into once.
                if (link.isSymbolicLink()) {
                    const real = canonicalDir(full);

                    if (visitedDirs.has(real)) {
                        logger.debug({ dir, full }, "[artifact] skipping a symlink that re-enters a visited folder");

                        continue;
                    }

                    visitedDirs.add(real);
                }

                if (!SKIP_DIRS.has(name) && depth < MAX_SCAN_DEPTH) {
                    walk(full, depth + 1);
                }

                continue;
            }

            const rel = relative(dir, full).split(sep).join("/");

            if (name.endsWith(".html")) {
                listing.html.push(rel);
            } else if (name.endsWith(".tsx") || name.endsWith(".jsx")) {
                listing.tsx.push(rel);
            } else if (name.endsWith(".md")) {
                listing.md.push(rel);
            }
        }
    };

    walk(dir, 0);
    listing.html.sort();
    listing.tsx.sort();
    listing.md.sort();

    return listing;
}

/**
 * Counting a folder's artifacts is a depth-4 directory walk, and both the
 * catalog route and the library page ask for it on every browser reload (and
 * every favicon retry). Cached for a few seconds: long enough to kill the
 * repeats, short enough that a file added during a dev loop still shows up.
 */
const SCAN_CACHE_TTL_MS = 5_000;
const scanCache = new Map<string, { at: number; listing: ArtifactListing }>();

export function cachedScan(dir: string, now: number = Date.now()): ArtifactListing {
    const hit = scanCache.get(dir);

    if (hit && now - hit.at < SCAN_CACHE_TTL_MS) {
        return hit.listing;
    }

    const listing = scanArtifacts(dir);
    scanCache.set(dir, { at: now, listing });

    return listing;
}

/** Clean-URL precedence when several artifacts share a basename. */
const CLEAN_EXTENSIONS = [".tsx", ".jsx", ".html", ".md"] as const;

function stripCleanExt(rel: string): string {
    return rel.replace(/\.(tsx|jsx|html|md)$/, "");
}

/**
 * Clean route for an artifact: `/Analysis/remake/postdeploy` instead of
 * `/__tsx/Analysis/remake/postdeploy.tsx`. When two artifacts share a basename
 * the higher-precedence one owns the clean URL and the other keeps its raw path.
 */
export function cleanHref(rel: string, listing: ArtifactListing): string {
    const base = stripCleanExt(rel);
    const all = [...listing.tsx, ...listing.html, ...listing.md];
    const owner = CLEAN_EXTENSIONS.map((ext) => `${base}${ext}`).find((cand) => all.includes(cand));

    if (owner === rel) {
        return `/${base}`;
    }

    return rel.endsWith(".md") ? `/__md/${rel}` : rel.endsWith(".html") ? `/${rel}` : `/__tsx/${rel}`;
}

export function renderCatalogHtml(dir: string, listing: ArtifactListing, templateDir: string, hrefPrefix = ""): string {
    const section = (label: string, kind: string, files: string[]): string => {
        if (files.length === 0) {
            return "";
        }

        const items = files
            .map(
                (rel) =>
                    `<li><a href="${escapeHtml(`${hrefPrefix}${encodeHrefPath(cleanHref(rel, listing))}`)}"><span class="name">${escapeHtml(rel)}</span>` +
                    `<span class="kind">${kind}</span></a></li>`
            )
            .join("\n");

        return `<section><h2>${label}</h2>\n<ul>${items}</ul></section>`;
    };

    const sections = [
        section("React", "tsx", listing.tsx),
        section("HTML", "html", listing.html),
        section("Markdown", "md", listing.md),
    ].join("\n");

    return renderTemplate(loadTemplate(templateDir, "catalog.html"), {
        TITLE: "Artifacts",
        DIR: escapeHtml(dir),
        SECTIONS: sections,
        THEME: loadThemeCss(templateDir),
    });
}

/**
 * Resolve a URL-relative path safely inside `dir`; null when it escapes or is
 * missing. The containment test runs on the CANONICAL path, so a symlink
 * planted inside the served folder cannot hand out a file outside it.
 */
export function safeResolve(dir: string, relUrl: string): string | null {
    let decoded: string;

    try {
        decoded = decodeURIComponent(relUrl);
    } catch (err) {
        logger.debug({ err, relUrl }, "[artifact] rejecting a request with a malformed percent-encoding");

        return null;
    }

    const full = resolve(dir, decoded);

    if (full !== dir && !full.startsWith(dir + sep)) {
        return null;
    }

    if (!existsSync(full) || !statSync(full).isFile()) {
        return null;
    }

    if (!isInsideDir(dir, full)) {
        logger.warn({ dir, full }, "[artifact] refusing a path that leaves the served folder through a symlink");

        return null;
    }

    return full;
}

/**
 * True when a URL path this plugin is about to hand DOWNSTREAM would reach a
 * real file or directory outside `dir`. Vite's static middleware resolves
 * lexically and follows symlinks, so a `.md`/`.html` request that falls through
 * (or one of the asset rewrites below) would otherwise serve exactly the file
 * safeResolve refuses on the plugin's own routes. Paths that do not name an
 * existing entry are left alone: those are Vite's (`/@vite/client`, `/@fs/…`).
 */
export function escapesServedDir(dir: string, urlPath: string): boolean {
    let decoded: string;

    try {
        decoded = decodeURIComponent(urlPath.replace(/^\/+/, ""));
    } catch (err) {
        logger.debug({ err, urlPath }, "[artifact] refusing to forward a malformed percent-encoding");

        return true;
    }

    const full = resolve(dir, decoded);

    if (!existsSync(full)) {
        return false;
    }

    return !isInsideDir(dir, full);
}

/** JSON-quote a string for embedding in generated JS (control chars + <-escape for script blocks). */
function quoteForJs(value: string): string {
    return SafeJSON.stringify(value, { strict: true }).replaceAll("<", "\\u003c");
}

export interface CleanResolution {
    kind: "tsx" | "html" | "md" | "dir";
    /** Artifact path relative to the served dir (with extension), or the dir itself. */
    rel: string;
    /** Clean base URL owning the artifact ("/Analysis/remake/postdeploy"). */
    base: string;
}

/**
 * Resolve an extension-less URL to an artifact: the LONGEST prefix of the path
 * that names a `.tsx`/`.jsx`/`.html`/`.md` file wins (precedence in that
 * order); the remainder is the artifact's client-side route. A full-path match
 * on a real directory yields that directory's catalog.
 */
export function resolveCleanUrl(dir: string, urlPath: string): CleanResolution | null {
    let segments: string[];

    try {
        segments = urlPath.split("/").filter(Boolean).map(decodeURIComponent);
    } catch (err) {
        logger.debug({ err, urlPath }, "[artifact] rejecting a clean URL with a malformed percent-encoding");

        return null;
    }

    if (segments.length === 0) {
        return null;
    }

    for (let take = segments.length; take >= 1; take--) {
        const prefix = segments.slice(0, take).join("/");
        const hasRemainder = take < segments.length;

        for (const ext of CLEAN_EXTENSIONS) {
            // Route remainders only make sense for React artifacts.
            if (hasRemainder && ext !== ".tsx" && ext !== ".jsx") {
                continue;
            }

            const rel = `${prefix}${ext}`;

            if (safeResolve(dir, rel)) {
                return {
                    kind: ext === ".html" ? "html" : ext === ".md" ? "md" : "tsx",
                    rel,
                    base: `/${prefix}`,
                };
            }
        }
    }

    const full = resolve(dir, segments.join("/"));

    if (
        (full === dir || full.startsWith(dir + sep)) &&
        existsSync(full) &&
        statSync(full).isDirectory() &&
        isInsideDir(dir, full)
    ) {
        return { kind: "dir", rel: segments.join("/"), base: `/${segments.join("/")}` };
    }

    return null;
}

function tsxEntryCode(rel: string, themeAbs: string): string {
    const stylesPath = join(RUNTIME_DIR, "styles.css").split(sep).join("/");
    const themePath = themeAbs.split(sep).join("/");

    return `import "/@fs/${stylesPath}";
import "/@fs/${themePath}";
import React from "react";
import { createRoot } from "react-dom/client";
import Component from ${quoteForJs(`/${rel}`)};
const el = document.getElementById("root");
createRoot(el).render(React.createElement(Component));
`;
}

export interface ServePluginOptions {
    dir: string;
    templateDir: string;
    /** Mount prefix when served under the library ("/a/<name>"); default "". */
    urlBase?: string;
}

/**
 * Dev-server plugin: catalog page at `/` (when the folder has no index.html)
 * and `/__catalog`, markdown rendering at `/__md/<rel>`, and React mounting at
 * `/__tsx/<rel>` via a virtual entry module (react-refresh HMR included).
 */
export function artifactServePlugin({ dir, templateDir, urlBase = "" }: ServePluginOptions): Plugin {
    const themeAbs = themeCssPath(templateDir);

    return {
        name: "artifact:serve",
        resolveId(id) {
            if (id.startsWith(TSX_ENTRY_PREFIX)) {
                return TSX_ENTRY_RESOLVED + id.slice(TSX_ENTRY_PREFIX.length);
            }

            return null;
        },
        load(id) {
            if (id.startsWith(TSX_ENTRY_RESOLVED)) {
                return tsxEntryCode(id.slice(TSX_ENTRY_RESOLVED.length), themeAbs);
            }

            return null;
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const respond = (html: string): void => {
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.end(html);
                };

                const notFound = (): void => {
                    res.statusCode = 404;
                    res.end("Not found");
                };

                // The ONE way this plugin hands a request downstream. Every
                // caller re-checks containment on the path Vite will actually
                // see, including the rewrites, because Vite does not.
                const forward = (rewrittenUrl?: string): void => {
                    if (rewrittenUrl !== undefined) {
                        req.url = rewrittenUrl;
                    }

                    const forwarded = new URL(req.url ?? "/", "http://localhost").pathname;
                    const rel = urlBase && forwarded.startsWith(urlBase) ? forwarded.slice(urlBase.length) : forwarded;

                    if (escapesServedDir(dir, rel)) {
                        logger.warn(
                            { dir, url: req.url },
                            "[artifact] refusing to forward a path that leaves the served folder"
                        );
                        notFound();

                        return;
                    }

                    next();
                };

                const serveTsxShell = async (rel: string, base: string): Promise<void> => {
                    const shell = renderTemplate(loadTemplate(templateDir, "tsx.html"), {
                        TITLE: escapeHtml(rel),
                        THEME: loadThemeCss(templateDir),
                        // Root-relative on purpose: vite's transformIndexHtml prepends
                        // the server base (the /a/<name>/ mount) itself.
                        ENTRY_SRC: `${TSX_ENTRY_PREFIX}${rel}`,
                    });
                    const transformed = await server.transformIndexHtml(base, shell);
                    respond(
                        transformed.replace(
                            /<head\b[^>]*>/i,
                            (m) => `${m}\n<script>window.__ARTIFACT_BASE__ = ${quoteForJs(base)};</script>`
                        )
                    );
                };

                const serveMdPage = (file: string): void => {
                    const rendered = renderMarkdown(readFileSync(file, "utf8"));
                    respond(
                        renderTemplate(loadTemplate(templateDir, "page.html"), {
                            TITLE: escapeHtml(relative(dir, file)),
                            CONTENT: rendered,
                            THEME: loadThemeCss(templateDir),
                        })
                    );
                };

                const handle = async (): Promise<void> => {
                    const url = new URL(req.url ?? "/", "http://localhost");
                    const rawPath = url.pathname;
                    const path =
                        urlBase && rawPath.startsWith(urlBase) ? rawPath.slice(urlBase.length) || "/" : rawPath;

                    if (path === "/__catalog" || (path === "/" && !existsSync(join(dir, "index.html")))) {
                        respond(renderCatalogHtml(dir, cachedScan(dir), templateDir, urlBase));

                        return;
                    }

                    // /__tsx/<rel>.tsx and every ROUTE under it (/__tsx/app.tsx/item/42)
                    // serve the shell — history-router deep links survive reload. A
                    // file-looking remainder is an asset request and rewrites to root.
                    const tsxMatch = path.match(/^\/__tsx\/(.+?\.(?:tsx|jsx))(\/.*)?$/);

                    if (tsxMatch) {
                        const rel = tsxMatch[1];
                        const sub = tsxMatch[2] ?? "";
                        const lastSegment = sub.split("/").pop() ?? "";

                        if (sub && lastSegment.includes(".")) {
                            forward(`${urlBase}${sub}${url.search}`);

                            return;
                        }

                        if (!safeResolve(dir, rel)) {
                            notFound();

                            return;
                        }

                        await serveTsxShell(rel, `${urlBase}/__tsx/${rel}`);

                        return;
                    }

                    // A page served under /__tsx/ or /__md/ makes the browser resolve
                    // relative fetches/links inside that URL space — rewrite any
                    // non-artifact asset request back to its real root path.
                    const viewerAsset = path.match(/^\/__(?:tsx|md)\/(.+)$/);

                    if (viewerAsset && !/\.(tsx|jsx|md)$/.test(path)) {
                        forward(`${urlBase}/${viewerAsset[1]}${url.search}`);

                        return;
                    }

                    if (path.startsWith("/__md/")) {
                        const file = safeResolve(dir, path.slice("/__md/".length));

                        if (!file) {
                            notFound();

                            return;
                        }

                        serveMdPage(file);

                        return;
                    }

                    // CLEAN URLS: an extension-less path resolves to the longest
                    // prefix naming an artifact — /demo serves demo.tsx (base /demo,
                    // so /demo/item/42 routes client-side), /notes renders notes.md,
                    // /report serves report.html, and a plain directory gets a catalog.
                    const lastSegment = path.split("/").pop() ?? "";

                    if (!path.startsWith("/__") && !lastSegment.includes(".")) {
                        const clean = resolveCleanUrl(dir, path);

                        if (clean?.kind === "tsx") {
                            await serveTsxShell(clean.rel, `${urlBase}${clean.base}`);

                            return;
                        }

                        if (clean?.kind === "md") {
                            const file = safeResolve(dir, clean.rel);

                            if (file) {
                                serveMdPage(file);

                                return;
                            }
                        }

                        if (clean?.kind === "html") {
                            forward(`${urlBase}/${clean.rel}${url.search}`);

                            return;
                        }

                        if (clean?.kind === "dir") {
                            const subDir = join(dir, clean.rel);
                            const sub = cachedScan(subDir);
                            const prefixed: ArtifactListing = {
                                html: sub.html.map((r) => `${clean.rel}/${r}`),
                                tsx: sub.tsx.map((r) => `${clean.rel}/${r}`),
                                md: sub.md.map((r) => `${clean.rel}/${r}`),
                            };
                            respond(renderCatalogHtml(subDir, prefixed, templateDir, urlBase));

                            return;
                        }
                    }

                    forward();
                };

                handle().catch(next);
            });
        },
    };
}
