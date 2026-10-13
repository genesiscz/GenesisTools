import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { CacheEntry, SourcemapCache } from "./cache.ts";
import { crawlAssets } from "./discover.ts";

const prof = profiler.scope("sourcemaps");

const { log } = logger.scoped("ts:sourcemaps:deployed");

/** Manifests that list a build's assets, tried in this order under the base URL. */
export const KNOWN_MANIFESTS = ["asset-manifest.json", ".vite/manifest.json", "manifest.json"];

const ASSET = /\.(m?js|css)$/;

/** The server answered that the asset does not exist (404/410): a fact about the deployment, not a failed fetch. */
class MissingAssetError extends Error {}

/** Every `.js`/`.mjs`/`.css` path a manifest names, whatever its shape (CRA `files`, Vite chunk records, flat maps). */
export function assetsFromManifest(manifest: unknown): string[] {
    const found = new Set<string>();
    const walk = (value: unknown): void => {
        if (typeof value === "string") {
            if (ASSET.test(value.split("?")[0])) {
                found.add(value);
            }

            return;
        }

        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }

        if (typeof value === "object" && value !== null) {
            Object.values(value).forEach(walk);
        }
    };
    walk(manifest);
    return [...found];
}

/** Resolves a manifest path against the base URL. Paths that already start with the base path stay as they are. */
export function assetUrl(baseUrl: string, asset: string): string {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (/^https?:\/\//.test(asset)) {
        return asset;
    }

    if (asset.startsWith("/")) {
        return new URL(asset, base.origin).href;
    }

    return new URL(asset, base).href;
}

export interface DiscoveredAssets {
    manifestUrl: string | null;
    urls: string[];
    /** How the list was found: a build manifest, or by following the page's scripts and chunk references. */
    via: "manifest" | "crawl" | "none";
    /** Bodies downloaded while crawling, so the snapshot does not fetch them again. */
    bodies?: Map<string, string>;
    /** Last-Modified (ISO) of the crawled files that sent one. */
    lastModified?: Map<string, string>;
    notes?: string[];
}

/**
 * Finds the asset list of a deployment: the first build manifest that answers, else by crawling the page's
 * scripts, the bundler runtime's chunk table and ES imports (rsbuild, Vite and most hosts publish no manifest).
 */
export async function discoverAssets(
    baseUrl: string,
    manifests: string[] = KNOWN_MANIFESTS,
    options: { crawl?: boolean; pages?: string[]; seeds?: string[] } = {}
): Promise<DiscoveredAssets> {
    const stopProfile = prof.start("discover");
    try {
        for (const name of manifests) {
            const url = assetUrl(baseUrl, name);
            const response = await fetch(url).catch((error: unknown) => {
                log.debug({ err: error, url }, "manifest fetch failed");
                return null;
            });
            if (!response?.ok) {
                continue;
            }

            const text = await response.text();
            try {
                const urls = assetsFromManifest(SafeJSON.parse(text)).map((asset) => assetUrl(baseUrl, asset));
                if (urls.length > 0) {
                    return { manifestUrl: url, urls: [...new Set(urls)].sort(), via: "manifest" };
                }
            } catch (error) {
                log.debug({ err: error, url }, "manifest is not JSON");
            }
        }

        if (options.crawl === false) {
            return { manifestUrl: null, urls: [], via: "none" };
        }

        const crawled = await crawlAssets({ baseUrl, pages: options.pages, seeds: options.seeds });
        return {
            manifestUrl: null,
            urls: crawled.urls,
            via: crawled.urls.length > 0 ? "crawl" : "none",
            bodies: crawled.bodies,
            lastModified: crawled.lastModified,
            notes: crawled.notes,
        };
    } finally {
        stopProfile();
    }
}

/** An HTTP date header as ISO, or undefined when absent or unparsable. */
export function isoOfHttpDate(value: string | null): string | undefined {
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** The `sourceMappingURL` of a JS file (last occurrence), or null. */
export function sourceMappingUrlOf(code: string): string | null {
    const matches = [...code.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm)];
    return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

export interface DeployedFile {
    url: string;
    /** Path inside the entry folder (the URL path). */
    path: string;
    bytes: number;
    /** The map saved next to it, when the deployment publishes one. */
    mapPath?: string;
    mapStatus?: "inline" | "fetched" | "missing" | "invalid" | "none-referenced";
    /** The server's Last-Modified for the file (ISO), roughly when the build was uploaded. */
    lastModified?: string;
}

export interface DeployedSnapshot {
    entry: CacheEntry;
    dir: string;
    files: DeployedFile[];
    reused: boolean;
}

/** Bump when the snapshot layout changes, so an old cached snapshot is not reused with a new reader. */
const SNAPSHOT_LAYOUT = "3";

/** A stable id for one deployment: host plus a hash of its sorted asset URLs. */
export function deploymentId(urls: string[]): string {
    const host = new URL(urls[0] ?? "http://unknown").host.replace(/[^a-z0-9.-]+/gi, "-");
    const hash = createHash("sha1")
        .update([SNAPSHOT_LAYOUT, ...[...urls].sort()].join("\n"))
        .digest("hex")
        .slice(0, 10);
    return `deployed-${host}-${hash}`;
}

/**
 * Where a deployed file lives inside the snapshot: its URL path relative to the base URL's path, so
 * `https://host/app/static/js/1.abc.js` under base `https://host/app/` is `static/js/1.abc.js`, the same
 * layout a local build folder has.
 */
export function snapshotPath(url: string, baseUrl: string): string {
    const path = new URL(url).pathname;
    const basePath = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).pathname;
    const relativePath = path.startsWith(basePath) ? path.slice(basePath.length) : path;
    return relativePath.replace(/^\/+/, "") || "index";
}

/**
 * `snapshotPath` for every URL, made unique. When several URLs share a path (`/config.js?v=1` and `?v=2`, or two
 * origins serving `/assets/main.js`), the first keeps it, the one a local build pairs with, and every other moves
 * under `_collisions/<url hash>/`, so no URL's file or map overwrites another's.
 */
export function snapshotPaths(urls: string[], baseUrl: string): Map<string, string> {
    const paths = new Map<string, string>();
    const taken = new Set<string>();
    for (const url of new Set(urls)) {
        const plain = snapshotPath(url, baseUrl);
        const path = taken.has(plain)
            ? `_collisions/${createHash("sha1").update(url).digest("hex").slice(0, 10)}/${plain}`
            : plain;
        taken.add(path);
        paths.set(url, path);
    }

    return paths;
}

async function fetchMap(fileUrl: string, code: string): Promise<{ status: DeployedFile["mapStatus"]; map?: string }> {
    const reference = sourceMappingUrlOf(code);
    if (!reference) {
        return { status: "none-referenced" };
    }

    if (reference.startsWith("data:")) {
        const comma = reference.indexOf(",");
        const payload = reference.slice(comma + 1);
        const text = reference.slice(0, comma).includes(";base64")
            ? Buffer.from(payload, "base64").toString("utf8")
            : decodeURIComponent(payload);
        return { status: "inline", map: text };
    }

    const response = await fetch(new URL(reference, fileUrl)).catch((error: unknown) => {
        log.debug({ err: error, fileUrl }, "map fetch failed");
        return null;
    });
    if (!response?.ok) {
        return { status: "missing" };
    }

    const text = await response.text();
    try {
        const parsed = SafeJSON.parse(text, { strict: true }) as { version?: unknown; mappings?: unknown };
        return parsed.version === 3 && typeof parsed.mappings === "string"
            ? { status: "fetched", map: text }
            : { status: "invalid" };
    } catch (error) {
        log.debug({ err: error, fileUrl }, "published map is not JSON");
        return { status: "invalid" };
    }
}

/**
 * Downloads a deployment's JS/CSS into the cache and tries each file's own `.map` first (the fast, exact
 * path when a deployment publishes maps). A deployment already in the cache is reused, not fetched again.
 */
export async function snapshotDeployment(options: {
    cache: SourcemapCache;
    baseUrl: string;
    urls: string[];
    concurrency?: number;
    refresh?: boolean;
    /** Bodies already downloaded (by discovery), used instead of a second request. */
    bodies?: Map<string, string>;
    /** Last-Modified (ISO) of the bodies above. */
    lastModified?: Map<string, string>;
}): Promise<DeployedSnapshot> {
    const stopProfile = prof.start("snapshot");
    try {
        if (options.urls.length === 0) {
            throw new Error(`no assets to fetch for ${options.baseUrl}; pass asset URLs or a base URL with a manifest`);
        }

        const id = deploymentId(options.urls);
        const dir = options.cache.entryDir(id);
        const existing = await options.cache.get(id);
        if (existing && !options.refresh) {
            await options.cache.touch(id);
            return { entry: existing, dir, files: await readSnapshotIndex(dir), reused: true };
        }

        await mkdir(dir, { recursive: true });
        const failed: Array<{ url: string; error: unknown }> = [];
        const paths = snapshotPaths(options.urls, options.baseUrl);
        const moved = options.urls.filter((url) => paths.get(url)?.startsWith("_collisions/"));
        if (moved.length > 0) {
            log.warn({ urls: moved }, "several asset URLs share a path; the later ones are kept under _collisions/");
        }

        const results = await concurrentMap({
            items: options.urls,
            concurrency: options.concurrency ?? 8,
            fn: async (url): Promise<DeployedFile> => {
                let code = options.bodies?.get(url);
                let lastModified = options.lastModified?.get(url);
                if (code === undefined) {
                    const response = await fetch(url);
                    if (!response.ok) {
                        const ErrorType =
                            response.status === 404 || response.status === 410 ? MissingAssetError : Error;
                        throw new ErrorType(`${response.status} for ${url}`);
                    }

                    code = await response.text();
                    lastModified = isoOfHttpDate(response.headers.get("last-modified"));
                }

                const path = paths.get(url) as string;
                await mkdir(dirname(join(dir, path)), { recursive: true });
                await writeFile(join(dir, path), code);
                const file: DeployedFile = { url, path, bytes: Buffer.byteLength(code) };
                if (lastModified) {
                    file.lastModified = lastModified;
                }

                if (/\.m?js$/.test(path)) {
                    const map = await fetchMap(url, code);
                    file.mapStatus = map.status;
                    if (map.map) {
                        file.mapPath = `${path}.map`;
                        await writeFile(join(dir, file.mapPath), map.map);
                    }
                }

                return file;
            },
            onError: (url, error) => {
                log.warn({ err: error, url }, "deployed asset fetch failed");
                if (!(error instanceof MissingAssetError)) {
                    failed.push({ url, error });
                }
            },
        });
        // A snapshot that lost files to a network error must not be cached: the next run would reuse it and every
        // position in a lost file would fail until --refresh. An asset the server says does not exist is skipped.
        const first = failed[0];
        if (first) {
            const reason = first.error instanceof Error ? first.error.message : String(first.error);
            throw new Error(
                `${failed.length} of ${options.urls.length} assets could not be fetched (first: ${first.url}: ${reason}); nothing was cached, run again`
            );
        }

        const files = options.urls.flatMap((url) => {
            const file = results.get(url);
            return file ? [file] : [];
        });
        await writeFile(join(dir, ".snapshot.json"), SafeJSON.stringify({ baseUrl: options.baseUrl, files }, null, 2));
        const entry = await options.cache.commit({
            id,
            kind: "deployed",
            label: `${new URL(options.baseUrl).host} (${files.length} assets)`,
            origin: { baseUrl: options.baseUrl },
        });
        return { entry, dir, files, reused: false };
    } finally {
        stopProfile();
    }
}

async function readSnapshotIndex(dir: string): Promise<DeployedFile[]> {
    const text = await readFile(join(dir, ".snapshot.json"), "utf8");
    return (SafeJSON.parse(text) as { files: DeployedFile[] }).files;
}

/** Every JS file under a folder, as paths relative to it (for local builds). */
export async function listJsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
        .sort();
}

/**
 * A deployment copy on disk (a downloaded artifact, or a local build standing in for a deployment). Each JS file
 * gets the URL it would have under `baseUrl` (default `file://<dir>/`), and its map when one sits next to it.
 */
export async function deployedFromDir(
    dir: string,
    baseUrl?: string
): Promise<{ dir: string; baseUrl: string; files: DeployedFile[] }> {
    const stopProfile = prof.start("deployed-dir");
    try {
        const base = baseUrl ?? `file://${dir.endsWith("/") ? dir : `${dir}/`}`;
        const files: DeployedFile[] = [];
        for (const path of await listJsFiles(dir)) {
            const code = await readFile(join(dir, path), "utf8");
            const reference = sourceMappingUrlOf(code);
            const named = reference && !reference.startsWith("data:") ? join(dirname(path), reference) : null;
            const mapPath = [named, `${path}.map`].find(
                (candidate): candidate is string => candidate !== null && existsSync(join(dir, candidate))
            );
            files.push({
                url: base.startsWith("file://") ? `${base}${path}` : assetUrl(base, path),
                path,
                bytes: Buffer.byteLength(code),
                mapPath,
                mapStatus: mapPath ? "fetched" : reference ? "missing" : "none-referenced",
            });
        }

        log.info(
            { dir, files: files.length, withMaps: files.filter((file) => file.mapPath).length },
            "deployment read from a folder"
        );
        return { dir, baseUrl: base, files };
    } finally {
        stopProfile();
    }
}
