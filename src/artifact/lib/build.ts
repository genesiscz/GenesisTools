import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { canonicalDir, isInsideDir } from "@genesiscz/utils/fs/canonical";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { build as viteBuild } from "vite";
import { renderMarkdown } from "./markdown";
import { escapeHtml, loadTemplate, loadThemeCss, renderTemplate, resolveTemplateDir } from "./templates";
import { basePlugins, baseResolve, cacheDirFor, RUNTIME_DIR } from "./vite";

const EMBED_EXTENSIONS = new Set([".md", ".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".txt", ".geojson"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const DEFAULT_EMBED_LIMIT_MB = 5;
/**
 * Cap across ALL embedded files of one build. The per-file cap alone bounds
 * nothing: a tree build of fifty files just under it embeds a quarter of a
 * gigabyte, which then travels through the shim JSON and the output string.
 */
const DEFAULT_EMBED_TOTAL_MB = 32;

export interface BuildOptions {
    dir: string;
    /** Entry HTML, relative to dir. */
    entry: string;
    /** Output file path. Default: `<dir>/dist/<entry basename>`. */
    out?: string;
    /** Per-file embed cap in MB for the fetch shim. */
    embedLimitMb?: number;
    /** Cap in MB on the embedded files TAKEN TOGETHER. */
    embedTotalMb?: number;
    /**
     * "tree" embeds every sibling text-data file (folder-shaped artifacts);
     * "referenced" embeds only files the ENTRY names (single-file artifacts —
     * building one file inside a vault must not inline the vault).
     */
    embedScope?: "tree" | "referenced";
    /** Theme for the generated chrome of a markdown build. Default: the shipped default. */
    templateDir?: string;
}

export interface BuildResult {
    outPath: string;
    bytes: number;
    /** Whether a Vite bundling pass ran (false = the entry had no local script/css refs). */
    bundled: boolean;
    embedded: string[];
    skippedEmbeds: SkippedEmbed[];
}

function isTsxEntry(entry: string): boolean {
    return entry.endsWith(".tsx") || entry.endsWith(".jsx");
}

function isMdEntry(entry: string): boolean {
    return entry.endsWith(".md");
}

/** Output file name for an entry: everything that is not already HTML becomes `<name>.html`. */
function outBaseFor(entry: string): string {
    return entry.endsWith(".html") ? basename(entry) : `${basename(entry).replace(/\.(tsx|jsx|md)$/, "")}.html`;
}

/**
 * Any EXPLICITLY named entry (file target, --entry flag, or a registry entry)
 * means "build this one artifact" — embed only what it references, never the
 * surrounding folder (it may be a vault). Only a bare directory whose entry was
 * auto-detected is folder-shaped and embeds the whole tree.
 */
export function embedScopeFor(source: {
    fileTargetEntry?: string | null;
    entryFlag?: string;
    registryEntry?: string;
}): "referenced" | "tree" {
    return source.fileTargetEntry || source.entryFlag || source.registryEntry ? "referenced" : "tree";
}

/** Pick the entry: explicit (.html/.tsx/.jsx/.md) > index.html > the only .html in the dir root. */
export function resolveEntry(dir: string, explicit: string | undefined): string {
    if (explicit) {
        const full = resolve(dir, explicit);

        if (!existsSync(full)) {
            throw new Error(`Entry not found: ${full}`);
        }

        if (!explicit.endsWith(".html") && !isTsxEntry(explicit) && !isMdEntry(explicit)) {
            throw new Error(`build needs an .html, .tsx/.jsx or .md entry (got "${explicit}").`);
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

/**
 * True when the HTML references local files that must be pulled into the page.
 * Media counts, not just scripts and stylesheets: a page whose only local
 * reference is `<img src="./logo.png">` is not self-contained either, and it
 * used to be emitted verbatim with the sibling URL intact.
 */
export function hasLocalAssetRefs(html: string): boolean {
    const external = /^(?:https?:)?\/\/|^data:|^#|^mailto:|^tel:/;
    const scriptSrc = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
    const linkHref = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
    const mediaSrc = /<(?:img|source|video|audio|embed|track)\b[^>]*\b(?:src|poster)\s*=\s*["']([^"']+)["']/gi;

    for (const match of [...html.matchAll(scriptSrc), ...html.matchAll(linkHref), ...html.matchAll(mediaSrc)]) {
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

/** Why a data file did not make it into the fetch shim. */
export type SkipReason = "too-large" | "budget";

export interface SkippedEmbed {
    rel: string;
    sizeBytes: number;
    reason: SkipReason;
}

export interface EmbedBudget {
    /** Largest single file that may be embedded. */
    limitBytes: number;
    /** Largest total the embedded files may reach together. */
    totalBytes: number;
}

interface EmbedScan {
    files: Record<string, string>;
    embedded: string[];
    skipped: SkippedEmbed[];
    /** Bytes already committed to `files`, measured against `EmbedBudget.totalBytes`. */
    totalBytes: number;
}

function emptyScan(): EmbedScan {
    return { files: {}, embedded: [], skipped: [], totalBytes: 0 };
}

/**
 * Charge one file against both caps. Returns false and records WHY when it does
 * not fit, so the caller can report an accurate reason instead of guessing.
 */
function admits(scan: EmbedScan, budget: EmbedBudget, rel: string, sizeBytes: number): boolean {
    if (sizeBytes > budget.limitBytes) {
        scan.skipped.push({ rel, sizeBytes, reason: "too-large" });

        return false;
    }

    if (scan.totalBytes + sizeBytes > budget.totalBytes) {
        scan.skipped.push({ rel, sizeBytes, reason: "budget" });

        return false;
    }

    scan.totalBytes += sizeBytes;

    return true;
}

/** Collect sibling text-data files (md/json/csv/…) for the file:// fetch shim. */
export function collectEmbeddableFiles(dir: string, budget: EmbedBudget, excludeAbs: Set<string>): EmbedScan {
    const scan = emptyScan();
    const visitedDirs = new Set<string>([canonicalDir(dir)]);

    const walk = (current: string): void => {
        for (const name of readdirSync(current)) {
            if (name.startsWith(".")) {
                continue;
            }

            const full = join(current, name);
            const link = lstatSync(full);

            // A symlink is followed only when its target still exists and stays
            // inside `dir`: building an artifact must never inline a file from
            // outside the folder the user pointed at.
            if (link.isSymbolicLink() && (!existsSync(full) || !isInsideDir(dir, full))) {
                logger.debug({ dir, full }, "[artifact] skipping a symlink that leaves the built folder");

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

            if (!admits(scan, budget, rel, stat.size)) {
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
    budget: EmbedBudget,
    excludeAbs: Set<string>
): EmbedScan {
    const scan = emptyScan();
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

        // isInsideDir, not a string prefix: a referenced `./data.json` may be a
        // symlink whose target sits outside the folder being built.
        if (!existsSync(abs) || !isInsideDir(dir, abs) || excludeAbs.has(abs)) {
            continue;
        }

        const rel = relative(dir, abs).split(sep).join("/");
        const size = statSync(abs).size;

        if (!admits(scan, budget, rel, size)) {
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
export function fetchShimScript(files: Record<string, string>, entryRel = ""): string {
    // The browser resolves relative fetches against the BUILT PAGE's location,
    // not the artifact root — for an entry in a subdirectory the two disagree.
    // Alias every embedded file under its entry-relative key too.
    const entryDir = entryRel.includes("/") ? entryRel.slice(0, entryRel.lastIndexOf("/") + 1) : "";
    const aliased: Record<string, string> = { ...files };

    if (entryDir) {
        for (const [key, value] of Object.entries(files)) {
            if (key.startsWith(entryDir)) {
                aliased[key.slice(entryDir.length)] = value;
            }
        }
    }

    // <-escape so no embedded content can contain "</script>" and end the tag early.
    const json = SafeJSON.stringify(aliased, { strict: true }).replaceAll("<", "\\u003c");

    return `<script>/* artifact:fetch-shim — embedded sibling files for file:// use; inert over http(s) */
(() => {
    if (location.protocol !== "file:") { return; }
    const FILES = ${json};
    const orig = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = (input, init) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || "";
        const noQuery = raw.split(/[?#]/)[0];
        const segments = [];
        for (const part of noQuery.split("/")) {
            if (part === "" || part === ".") { continue; }
            if (part === "..") { segments.pop(); continue; }
            segments.push(part);
        }
        const key = decodeURIComponent(segments.join("/"));
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
    // Tailwind's automatic source detection is rooted at tmpRoot here, so the
    // artifact dir must be registered explicitly or entry-only classes drop.
    const buildCss = `@import ${SafeJSON.stringify(relative(tmpRoot, stylesAbs).split(sep).join("/"), { strict: true })};
@source ${SafeJSON.stringify(relative(tmpRoot, dir).split(sep).join("/"), { strict: true })};
`;
    await Bun.write(join(tmpRoot, "build.css"), buildCss);
    await Bun.write(
        join(tmpRoot, "mount.tsx"),
        `import "./build.css";
import React from "react";
import { createRoot } from "react-dom/client";
import Component from ${SafeJSON.stringify(entryAbs, { strict: true })};
createRoot(document.getElementById("root") as HTMLElement).render(React.createElement(Component));
`
    );
    await Bun.write(
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

/**
 * Render a markdown entry into the template's page chrome, theme CSS inlined.
 * No bundler runs: the output is already one self-contained HTML file.
 */
function buildMdEntry(dir: string, entryAbs: string, templateDir: string): string {
    const rendered = renderMarkdown(readFileSync(entryAbs, "utf8"));

    return renderTemplate(loadTemplate(templateDir, "page.html"), {
        TITLE: escapeHtml(relative(dir, entryAbs).split(sep).join("/")),
        CONTENT: rendered,
        THEME: loadThemeCss(templateDir),
    });
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
    } else if (isMdEntry(entryRel)) {
        bundled = true;
        html = buildMdEntry(dir, entryAbs, options.templateDir ?? resolveTemplateDir(undefined));
    } else {
        const source = readFileSync(entryAbs, "utf8");
        bundled = hasLocalAssetRefs(source);
        html = bundled ? await buildHtmlEntry(dir, entryRel, entryAbs) : source;
    }

    const outBase = outBaseFor(entryRel);
    const outPath = resolve(options.out ?? join(dir, "dist", outBase));

    if (outPath === entryAbs) {
        throw new Error("Output path equals the entry file — refusing to overwrite the source.");
    }

    const budget: EmbedBudget = {
        limitBytes: (options.embedLimitMb ?? DEFAULT_EMBED_LIMIT_MB) * 1024 * 1024,
        totalBytes: (options.embedTotalMb ?? DEFAULT_EMBED_TOTAL_MB) * 1024 * 1024,
    };
    const exclude = new Set([entryAbs, outPath]);
    const scan =
        options.embedScope === "referenced"
            ? collectReferencedFiles(dir, entryRel, budget, exclude)
            : collectEmbeddableFiles(dir, budget, exclude);
    const overBudget = scan.skipped.filter((skip) => skip.reason === "budget");

    if (overBudget.length > 0) {
        logger.warn(
            { dir, totalBytes: scan.totalBytes, budgetBytes: budget.totalBytes, dropped: overBudget.length },
            "[artifact] embed budget reached; the remaining data files were left out"
        );
    }

    if (scan.embedded.length > 0) {
        html = injectShim(html, fetchShimScript(scan.files, entryRel));
    }

    mkdirSync(dirname(outPath), { recursive: true });
    await Bun.write(outPath, html);
    const bytes = Buffer.byteLength(html);
    logger.info(
        { outPath, bytes, bundled, embedded: scan.embedded.length, skipped: scan.skipped.length },
        "[artifact] build finished"
    );

    return { outPath, bytes, bundled, embedded: scan.embedded, skippedEmbeds: scan.skipped };
}

/**
 * The absolute path `buildSingleFile` will write for these options, worked out
 * WITHOUT building. The watcher needs it up front so it can ignore its own
 * output; both paths go through `outBaseFor` so they cannot disagree.
 */
export function resolveOutPath(options: BuildOptions): string {
    return resolve(options.out ?? join(resolve(options.dir), "dist", outBaseFor(options.entry)));
}

/**
 * Watch the artifact dir and rebuild the single-file output on every change
 * (debounced). Rebuilds cover the entry, its imports, and embedded data files
 * alike — the whole pipeline re-runs, which keeps the logic in one place.
 */
export function watchAndRebuild(options: BuildOptions, onBuild: (result: BuildResult) => void): () => void {
    const dir = resolve(options.dir);
    const outAbs = resolveOutPath(options);
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
        const name = (filename ?? "").split(sep).join("/");

        // Skipping the output file is what breaks the rebuild->watch->rebuild loop
        // when --out points inside the watched dir but not under dist/.
        if (
            name.startsWith("dist/") ||
            name.startsWith(".") ||
            name.includes("node_modules") ||
            resolve(dir, name) === outAbs
        ) {
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
