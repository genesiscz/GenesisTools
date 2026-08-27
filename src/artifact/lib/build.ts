import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { build as viteBuild } from "vite";
import { basePlugins, baseResolve, cacheDirFor, RUNTIME_DIR } from "./vite";

const EMBED_EXTENSIONS = new Set([".md", ".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".txt", ".geojson"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const DEFAULT_EMBED_LIMIT_MB = 5;

export interface BuildOptions {
    dir: string;
    /** Entry HTML, relative to dir. */
    entry: string;
    /** Output file path. Default: `<dir>/dist/<entry basename>`. */
    out?: string;
    /** Per-file embed cap in MB for the fetch shim. */
    embedLimitMb?: number;
    /**
     * "tree" embeds every sibling text-data file (folder-shaped artifacts);
     * "referenced" embeds only files the ENTRY names (single-file artifacts —
     * building one file inside a vault must not inline the vault).
     */
    embedScope?: "tree" | "referenced";
}

export interface BuildResult {
    outPath: string;
    bytes: number;
    /** Whether a Vite bundling pass ran (false = the entry had no local script/css refs). */
    bundled: boolean;
    embedded: string[];
    skippedEmbeds: Array<{ rel: string; sizeBytes: number }>;
}

function isTsxEntry(entry: string): boolean {
    return entry.endsWith(".tsx") || entry.endsWith(".jsx");
}

/** Pick the entry: explicit (.html/.tsx/.jsx) > index.html > the only .html in the dir root. */
export function resolveEntry(dir: string, explicit: string | undefined): string {
    if (explicit) {
        const full = resolve(dir, explicit);

        if (!existsSync(full)) {
            throw new Error(`Entry not found: ${full}`);
        }

        if (!explicit.endsWith(".html") && !isTsxEntry(explicit)) {
            throw new Error(`build needs an .html or .tsx/.jsx entry (got "${explicit}").`);
        }

        return relative(dir, full).split(sep).join("/");
    }

    if (existsSync(join(dir, "index.html"))) {
        return "index.html";
    }

    const htmlFiles = readdirSync(dir).filter((f) => f.endsWith(".html"));

    if (htmlFiles.length === 1) {
        return htmlFiles[0];
    }

    if (htmlFiles.length === 0) {
        throw new Error(`No .html entry in ${dir}. Pass --entry <file>.`);
    }

    throw new Error(`Multiple .html files in ${dir} — pass --entry. Candidates: ${htmlFiles.join(", ")}`);
}

/** True when the HTML references local scripts or stylesheets that need bundling. */
export function hasLocalAssetRefs(html: string): boolean {
    const external = /^(?:https?:)?\/\/|^data:|^#/;
    const scriptSrc = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    const linkHref = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi;

    for (const match of [...html.matchAll(scriptSrc), ...html.matchAll(linkHref)]) {
        if (!external.test(match[1])) {
            return true;
        }
    }

    return false;
}

/**
 * Inline every local script/stylesheet reference of a built HTML using
 * `readAsset(relPath)`, producing a self-contained page. Modulepreload hints
 * are dropped (everything is inline).
 */
export function inlineAssets(html: string, readAsset: (rel: string) => string): string {
    const normalize = (ref: string): string => ref.replace(/^\.\//, "").replace(/^\//, "");

    let out = html.replace(
        /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
        (full, _pre, ref: string) => {
            if (/^(?:https?:)?\/\/|^data:/.test(ref)) {
                return full;
            }

            const code = readAsset(normalize(ref));

            return `<script type="module">\n${code}\n</script>`;
        }
    );

    out = out.replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi, (full) => {
        const href = full.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];

        if (!href || /^(?:https?:)?\/\/|^data:/.test(href)) {
            return full;
        }

        return `<style>\n${readAsset(normalize(href))}\n</style>`;
    });

    out = out.replace(/[ \t]*<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>\n?/gi, "");

    return out;
}

interface EmbedScan {
    files: Record<string, string>;
    embedded: string[];
    skipped: Array<{ rel: string; sizeBytes: number }>;
}

/** Collect sibling text-data files (md/json/csv/…) for the file:// fetch shim. */
export function collectEmbeddableFiles(dir: string, limitBytes: number, excludeAbs: Set<string>): EmbedScan {
    const scan: EmbedScan = { files: {}, embedded: [], skipped: [] };

    const walk = (current: string): void => {
        for (const name of readdirSync(current)) {
            if (name.startsWith(".")) {
                continue;
            }

            const full = join(current, name);
            const stat = statSync(full);

            if (stat.isDirectory()) {
                if (!SKIP_DIRS.has(name)) {
                    walk(full);
                }

                continue;
            }

            const ext = name.slice(name.lastIndexOf("."));

            if (!EMBED_EXTENSIONS.has(ext) || excludeAbs.has(full)) {
                continue;
            }

            const rel = relative(dir, full).split(sep).join("/");

            if (stat.size > limitBytes) {
                scan.skipped.push({ rel, sizeBytes: stat.size });

                continue;
            }

            scan.files[rel] = readFileSync(full, "utf8");
            scan.embedded.push(rel);
        }
    };

    walk(dir);
    scan.embedded.sort();

    return scan;
}

/**
 * Referenced-only embed scan: relative data-path string literals in the entry
 * source plus the `<entry>.data*.json` sibling convention. Used for
 * single-file builds so the surrounding folder never inlines wholesale.
 */
export function collectReferencedFiles(
    dir: string,
    entryRel: string,
    limitBytes: number,
    excludeAbs: Set<string>
): EmbedScan {
    const scan: EmbedScan = { files: {}, embedded: [], skipped: [] };
    const entryAbs = join(dir, entryRel);
    const source = readFileSync(entryAbs, "utf8");
    const refs = new Set<string>();
    const literal = /["'`](\.{0,2}\/[^"'`\n]+?\.(?:md|json|jsonl|ndjson|csv|tsv|txt|geojson))["'`]/g;

    for (const match of source.matchAll(literal)) {
        refs.add(match[1]);
    }

    const entryDirAbs = dirname(entryAbs);
    const base = basename(entryRel).replace(/\.(tsx|jsx|html)$/, "");

    for (const sibling of readdirSync(entryDirAbs)) {
        if (sibling.startsWith(`${base}.data`) && sibling.endsWith(".json")) {
            refs.add(`./${sibling}`);
        }
    }

    for (const ref of refs) {
        const abs = resolve(entryDirAbs, ref);

        if (!abs.startsWith(dir + sep) || !existsSync(abs) || excludeAbs.has(abs)) {
            continue;
        }

        const rel = relative(dir, abs).split(sep).join("/");
        const size = statSync(abs).size;

        if (size > limitBytes) {
            scan.skipped.push({ rel, sizeBytes: size });

            continue;
        }

        scan.files[rel] = readFileSync(abs, "utf8");
        scan.embedded.push(rel);
    }

    scan.embedded.sort();

    return scan;
}

/**
 * Fetch shim injected into built pages: on file:// (where fetch() of a sibling
 * file is blocked), relative-URL fetches are answered from the embedded map.
 * Served over http the shim is inert and the real files stay authoritative.
 */
export function fetchShimScript(files: Record<string, string>): string {
    // <-escape so no embedded content can contain "</script>" and end the tag early.
    const json = SafeJSON.stringify(files, { strict: true }).replaceAll("<", "\\u003c");

    return `<script>/* artifact:fetch-shim — embedded sibling files for file:// use; inert over http(s) */
(() => {
    if (location.protocol !== "file:") { return; }
    const FILES = ${json};
    const orig = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (input, init) => {
        const raw = typeof input === "string" ? input : (input && input.url) || "";
        const key = decodeURIComponent(raw.replace(/^\\.\\//, "").split(/[?#]/)[0]);
        if (Object.prototype.hasOwnProperty.call(FILES, key)) {
            return Promise.resolve(new Response(FILES[key], { status: 200 }));
        }
        return orig ? orig(input, init) : Promise.reject(new TypeError("fetch unavailable on file://"));
    };
})();
</script>`;
}

/** Insert the shim right after <head> so it patches fetch before any page script runs. */
export function injectShim(html: string, shim: string): string {
    const headMatch = html.match(/<head\b[^>]*>/i);

    if (headMatch?.index !== undefined) {
        const at = headMatch.index + headMatch[0].length;

        return `${html.slice(0, at)}\n${shim}${html.slice(at)}`;
    }

    return `${shim}\n${html}`;
}

const SHARED_BUILD = {
    configFile: false,
    envFile: false,
    base: "./",
    logLevel: "warn",
} as const;

function buildOutputOptions(outDir: string, input: string) {
    return {
        outDir,
        emptyOutDir: true,
        cssCodeSplit: false,
        modulePreload: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        rollupOptions: { input },
    };
}

/** Bundle an .html entry in place. */
async function buildHtmlEntry(dir: string, entryRel: string, entryAbs: string): Promise<string> {
    const outDir = join(cacheDirFor(dir), "build");
    await viteBuild({
        ...SHARED_BUILD,
        root: dir,
        cacheDir: cacheDirFor(dir),
        plugins: basePlugins(),
        resolve: baseResolve(),
        build: buildOutputOptions(outDir, entryAbs),
    });
    const builtHtml = readFileSync(join(outDir, entryRel), "utf8");

    return inlineAssets(builtHtml, (rel) => readFileSync(join(outDir, rel), "utf8"));
}

/**
 * Bundle a single .tsx/.jsx component file: a wrapper entry (mount + kit
 * styles) is generated in the tool's cache dir, so the artifact stays ONE file
 * with no folder scaffolding.
 */
async function buildTsxEntry(dir: string, entryRel: string, entryAbs: string): Promise<string> {
    const title = basename(entryRel).replace(/\.(tsx|jsx)$/, "");
    const tmpRoot = join(cacheDirFor(dir), "tsx-entry");
    const stylesAbs = join(RUNTIME_DIR, "styles.css");
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(
        join(tmpRoot, "mount.tsx"),
        `import ${SafeJSON.stringify(stylesAbs, { strict: true })};
import React from "react";
import { createRoot } from "react-dom/client";
import Component from ${SafeJSON.stringify(entryAbs, { strict: true })};
createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(Component));
`
    );
    writeFileSync(
        join(tmpRoot, "index.html"),
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
<div id="root"></div>
<script type="module" src="./mount.tsx"></script>
</body>
</html>
`
    );

    const outDir = join(cacheDirFor(dir), "build");
    await viteBuild({
        ...SHARED_BUILD,
        root: tmpRoot,
        cacheDir: cacheDirFor(dir),
        plugins: basePlugins(),
        resolve: baseResolve(),
        build: buildOutputOptions(outDir, join(tmpRoot, "index.html")),
    });
    const builtHtml = readFileSync(join(outDir, "index.html"), "utf8");

    return inlineAssets(builtHtml, (rel) => readFileSync(join(outDir, rel), "utf8"));
}

export async function buildSingleFile(options: BuildOptions): Promise<BuildResult> {
    const dir = resolve(options.dir);
    const entryRel = options.entry;
    const entryAbs = join(dir, entryRel);
    let bundled: boolean;
    let html: string;

    if (isTsxEntry(entryRel)) {
        bundled = true;
        html = await buildTsxEntry(dir, entryRel, entryAbs);
    } else {
        const source = readFileSync(entryAbs, "utf8");
        bundled = hasLocalAssetRefs(source);
        html = bundled ? await buildHtmlEntry(dir, entryRel, entryAbs) : source;
    }

    const outBase = isTsxEntry(entryRel)
        ? `${basename(entryRel).replace(/\.(tsx|jsx)$/, "")}.html`
        : basename(entryRel);
    const outPath = resolve(options.out ?? join(dir, "dist", outBase));

    if (outPath === entryAbs) {
        throw new Error("Output path equals the entry file — refusing to overwrite the source.");
    }

    const limitBytes = (options.embedLimitMb ?? DEFAULT_EMBED_LIMIT_MB) * 1024 * 1024;
    const exclude = new Set([entryAbs, outPath]);
    const scan =
        options.embedScope === "referenced"
            ? collectReferencedFiles(dir, entryRel, limitBytes, exclude)
            : collectEmbeddableFiles(dir, limitBytes, exclude);

    if (scan.embedded.length > 0) {
        html = injectShim(html, fetchShimScript(scan.files));
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    logger.info(
        { outPath, bytes: html.length, bundled, embedded: scan.embedded.length, skipped: scan.skipped.length },
        "[artifact] build finished"
    );

    return {
        outPath,
        bytes: Buffer.byteLength(html),
        bundled,
        embedded: scan.embedded,
        skippedEmbeds: scan.skipped,
    };
}

/**
 * Watch the artifact dir and rebuild the single-file output on every change
 * (debounced). Rebuilds cover the entry, its imports, and embedded data files
 * alike — the whole pipeline re-runs, which keeps the logic in one place.
 */
export function watchAndRebuild(options: BuildOptions, onBuild: (result: BuildResult) => void): () => void {
    const dir = resolve(options.dir);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let building = false;
    let dirty = false;

    const rebuild = (): void => {
        if (building) {
            dirty = true;

            return;
        }

        building = true;
        buildSingleFile(options)
            .then((result) => onBuild(result))
            .catch((err: unknown) => {
                logger.warn({ err }, "[artifact] watch rebuild failed");
            })
            .finally(() => {
                building = false;

                if (dirty) {
                    dirty = false;
                    rebuild();
                }
            });
    };

    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        const name = filename ?? "";

        if (name.startsWith("dist/") || name.startsWith(".") || name.includes("node_modules")) {
            return;
        }

        if (timer) {
            clearTimeout(timer);
        }

        timer = setTimeout(rebuild, 300);
    });

    return () => {
        if (timer) {
            clearTimeout(timer);
        }

        watcher.close();
    };
}
