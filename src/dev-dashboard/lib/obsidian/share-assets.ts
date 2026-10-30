import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type ResolvedAsset, renderCodeLines, renderMarkdown } from "@app/dev-dashboard/lib/obsidian/markdown";
import { headingSlug } from "@app/dev-dashboard/lib/obsidian/obsidian-syntax";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { redactSecretsInText } from "@genesiscz/utils/transclude";

const { log } = logger.scoped("share-assets");

export const SHARE_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const SHARE_ASSET_HASH_RE = /^[0-9a-f]{64}$/;

type AssetKind = Exclude<ResolvedAsset["kind"], "page">;

interface AssetType {
    contentType: string;
    kind: AssetKind;
    /** highlight.js language for a code file. */
    language?: string;
}

const TEXT_PLAIN = "text/plain; charset=utf-8";

const CODE_LANGUAGES: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "bash",
    ".swift": "swift",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".kt": "kotlin",
    ".php": "php",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".m": "objectivec",
    ".css": "css",
    ".html": "xml",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "ini",
    ".ini": "ini",
    ".sql": "sql",
    ".jsonl": "json",
    ".txt": "plaintext",
    ".log": "plaintext",
};

const CODE_WINDOW_LINES = 400;
const CODE_CONTEXT_LINES = 40;

const ASSET_TYPES: Record<string, AssetType> = {
    ".md": { contentType: "text/markdown; charset=utf-8", kind: "markdown" },
    ...Object.fromEntries(
        Object.entries(CODE_LANGUAGES).map(([ext, language]) => [
            ext,
            { contentType: TEXT_PLAIN, kind: "code" as const, language },
        ])
    ),
    ".webp": { contentType: "image/webp", kind: "image" },
    ".png": { contentType: "image/png", kind: "image" },
    ".jpg": { contentType: "image/jpeg", kind: "image" },
    ".jpeg": { contentType: "image/jpeg", kind: "image" },
    ".gif": { contentType: "image/gif", kind: "image" },
    ".avif": { contentType: "image/avif", kind: "image" },
    ".svg": { contentType: "image/svg+xml", kind: "image" },
    ".json": { contentType: "application/json; charset=utf-8", kind: "json" },
    // Obsidian's embeddable audio, video and PDF formats.
    ".mp3": { contentType: "audio/mpeg", kind: "audio" },
    ".m4a": { contentType: "audio/mp4", kind: "audio" },
    ".wav": { contentType: "audio/wav", kind: "audio" },
    ".ogg": { contentType: "audio/ogg", kind: "audio" },
    ".flac": { contentType: "audio/flac", kind: "audio" },
    ".3gp": { contentType: "audio/3gpp", kind: "audio" },
    ".mp4": { contentType: "video/mp4", kind: "video" },
    ".mov": { contentType: "video/quicktime", kind: "video" },
    ".webm": { contentType: "video/webm", kind: "video" },
    ".ogv": { contentType: "video/ogg", kind: "video" },
    ".mkv": { contentType: "video/x-matroska", kind: "video" },
    ".pdf": { contentType: "application/pdf", kind: "pdf" },
};

const MEDIA_KINDS = new Set<AssetKind>(["image", "audio", "video", "pdf"]);

/** A file the page shows as itself (picture, player, PDF viewer) and serves as bytes, never in a side panel. */
export function isMediaKind(kind: AssetKind): boolean {
    return MEDIA_KINDS.has(kind);
}

const SKIPPED_DIRS = new Set(["node_modules"]);

export interface ShareAsset {
    hash: string;
    /** Real path on disk, proven to sit inside the vault's real root. */
    absPath: string;
    vaultPath: string;
    name: string;
    kind: AssetKind;
    contentType: string;
    language?: string;
}

export interface ShareAssetIndex {
    /** Raw reference text as the note wrote it (`../artifacts/x.webp`) to the asset. */
    byTarget: Map<string, ShareAsset>;
    byHash: Map<string, ShareAsset>;
}

export function shareAssetUrl(slug: string, hash: string): string {
    return `/share/${encodeURIComponent(slug)}?asset=${hash}`;
}

/**
 * Every asset reference the renderer will ask about. It runs the real renderer with a recording
 * resolver, so a reference inside a code block is skipped exactly as the rendered page skips it.
 */
export function collectAssetTargets(source: string): string[] {
    const targets = new Set<string>();

    renderMarkdown(source, {
        resolveWikilink: () => null,
        resolveAsset: (target) => {
            targets.add(target);

            return null;
        },
    });

    return [...targets];
}

/** The highlight.js language of a source file, or null when the path is not one. */
export function codeLanguageFor(path: string): string | null {
    return CODE_LANGUAGES[posix.extname(path).toLowerCase()] ?? null;
}

/** `text` as one fenced block, with a fence longer than any backtick run inside it. */
export function fencedCode(text: string, language: string): string {
    const body = text.replace(/\n$/, "");
    const longestRun = (body.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
    const fence = "`".repeat(Math.max(3, longestRun + 1));

    return `${fence}${language}\n${body}\n${fence}\n`;
}

function assetTypeFor(path: string): AssetType | null {
    return ASSET_TYPES[posix.extname(path).toLowerCase()] ?? null;
}

/** `#L35` or `#L35-L40` on a reference, as a 1-based inclusive range. */
export function lineRangeOf(target: string): { start: number; end: number } | null {
    const match = /#L(\d{1,7})(?:-L?(\d{1,7}))?$/.exec(target.trim());

    if (!match) {
        return null;
    }

    const start = Number(match[1]);
    const end = match[2] ? Math.max(start, Number(match[2])) : start;

    return { start, end };
}

/**
 * The vault-relative path a reference names. A `file://` URL counts only when it points inside the
 * vault, and it names exactly one file. Anything else goes through Obsidian's lookup, and a name
 * without a known extension is a note (`[[wrapup-body]]` is `wrapup-body.md`).
 */
function parseTarget(target: string, vaultRoots: string[]): { path: string; exact: boolean } | null {
    if (/^file:/i.test(target.trim())) {
        let absolute: string;

        try {
            absolute = fileURLToPath(target.trim().replace(/#.*$/, ""));
        } catch (err) {
            log.debug({ target, err }, "file: reference is not a valid file URL");

            return null;
        }

        for (const root of vaultRoots) {
            const rel = relative(root, absolute);

            if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) && !rel.includes("\0")) {
                return { path: rel.split(sep).join("/"), exact: true };
            }
        }

        return null;
    }

    const cleaned = cleanTarget(target);

    if (!cleaned || cleaned.endsWith("/")) {
        return null;
    }

    return { path: assetTypeFor(cleaned) ? cleaned : `${cleaned}.md`, exact: false };
}

function cleanTarget(target: string): string {
    let cleaned = target.trim().replace(/[#?].*$/, "");

    try {
        cleaned = decodeURIComponent(cleaned);
    } catch {
        log.debug({ target }, "asset target is not URI-encoded, using it verbatim");
    }

    return cleaned.replace(/\\/g, "/");
}

/** A vault-relative candidate, or null when normalisation leaves the vault. */
function vaultRelative(path: string): string | null {
    const normalized = posix.normalize(path).replace(/^\/+/, "");

    if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0")) {
        return null;
    }

    return normalized;
}

async function readAttachmentFolder(vaultRoot: string): Promise<string | null> {
    try {
        const config: unknown = SafeJSON.parse(await readFile(resolve(vaultRoot, ".obsidian/app.json"), "utf8"));

        if (typeof config === "object" && config !== null && "attachmentFolderPath" in config) {
            return typeof config.attachmentFolderPath === "string" ? config.attachmentFolderPath : null;
        }

        return null;
    } catch (err) {
        log.debug({ err }, "no readable .obsidian/app.json, skipping the attachment folder rule");

        return null;
    }
}

function attachmentDir(setting: string | null, noteDir: string): string | null {
    if (setting === null) {
        return null;
    }

    if (setting === "/" || setting === "") {
        return "";
    }

    if (setting === "." || setting.startsWith("./")) {
        return posix.join(noteDir, setting);
    }

    return setting;
}

async function listVaultFiles(vaultRoot: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(rel: string): Promise<void> {
        let items: Dirent[];

        try {
            items = await readdir(resolve(vaultRoot, rel), { withFileTypes: true });
        } catch (err) {
            // An unreadable folder (EACCES, a folder removed mid-walk) only hides its files; the page renders.
            log.debug({ err, rel }, "share assets: skipping an unreadable vault folder");
            return;
        }

        for (const item of items) {
            if (item.name.startsWith(".") || SKIPPED_DIRS.has(item.name)) {
                continue;
            }

            const child = rel ? `${rel}/${item.name}` : item.name;

            if (item.isDirectory()) {
                await walk(child);
            } else if (item.isFile() && assetTypeFor(item.name)) {
                files.push(child);
            }
        }
    }

    await walk("");

    return files;
}

function pickVaultWideMatch(files: string[], target: string, noteDir: string): string | null {
    const suffix = target.replace(/^(\.\.?\/)+/, "");
    const base = posix.basename(suffix);
    const matches = files.filter((file) => {
        if (posix.basename(file) !== base) {
            return false;
        }

        return !suffix.includes("/") || file === suffix || file.endsWith(`/${suffix}`);
    });

    if (matches.length === 0) {
        return null;
    }

    const sameDir = matches.find((file) => posix.dirname(file) === (noteDir || "."));

    return sameDir ?? matches.sort((a, b) => a.length - b.length)[0];
}

function isInside(root: string, full: string): boolean {
    return full === root || full.startsWith(`${root}${sep}`);
}

/** Load one candidate, or null when it is missing, too big, not a file, or its real path leaves the vault. */
async function loadCandidate(
    vaultRoot: string,
    vaultReal: string,
    rel: string
): Promise<{ absPath: string; bytes: Buffer } | null> {
    const lexical = resolve(vaultRoot, rel);

    if (!isInside(resolve(vaultRoot), lexical)) {
        return null;
    }

    try {
        const absPath = await realpath(lexical);

        if (!isInside(vaultReal, absPath)) {
            log.warn({ rel }, "share asset resolves outside the vault, refusing it");

            return null;
        }

        const info = await stat(absPath);

        if (!info.isFile() || info.size > SHARE_ASSET_MAX_BYTES) {
            return null;
        }

        return { absPath, bytes: await readFile(absPath) };
    } catch (err) {
        log.debug({ rel, err }, "share asset candidate is not readable");

        return null;
    }
}

export function hashAsset(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve every file the note references, with Obsidian's lookup order: next to the note (relative
 * paths included), the vault root, the configured attachment folder, then any file in the vault
 * with that name. Only these files are ever served, and only by their content hash.
 */
export async function buildShareAssetIndex(options: {
    vaultRoot: string;
    notePath: string;
    source: string;
}): Promise<ShareAssetIndex> {
    const { vaultRoot, notePath, source } = options;
    const vaultReal = await realpath(resolve(vaultRoot));
    const noteDir = posix.dirname(notePath) === "." ? "" : posix.dirname(notePath);
    const index: ShareAssetIndex = { byTarget: new Map(), byHash: new Map() };
    const vaultRoots = [...new Set([resolve(vaultRoot), vaultReal])];
    const targets = collectAssetTargets(source);

    if (targets.length === 0) {
        return index;
    }

    const attachSetting = await readAttachmentFolder(vaultRoot);
    let vaultFiles: string[] | null = null;

    for (const target of targets) {
        const parsed = parseTarget(target, vaultRoots);
        const type = parsed ? assetTypeFor(parsed.path) : null;

        if (!parsed || !type) {
            continue;
        }

        const cleaned = parsed.path;
        const attachDir = attachmentDir(attachSetting, noteDir);
        const candidates = (
            parsed.exact
                ? [cleaned]
                : [
                      posix.join(noteDir, cleaned),
                      cleaned,
                      attachDir === null ? null : posix.join(attachDir, posix.basename(cleaned)),
                  ]
        )
            .map((candidate) => (candidate === null ? null : vaultRelative(candidate)))
            .filter((candidate): candidate is string => candidate !== null);

        let found: { rel: string; absPath: string; bytes: Buffer } | null = null;

        for (const rel of new Set(candidates)) {
            const loaded = await loadCandidate(vaultRoot, vaultReal, rel);

            if (loaded) {
                found = { rel, ...loaded };
                break;
            }
        }

        if (!found && !parsed.exact) {
            vaultFiles ??= await listVaultFiles(vaultRoot);
            const match = pickVaultWideMatch(vaultFiles, cleaned, noteDir);
            const loaded = match ? await loadCandidate(vaultRoot, vaultReal, match) : null;

            if (match && loaded) {
                found = { rel: match, ...loaded };
            }
        }

        if (!found) {
            log.debug({ notePath, target }, "share asset reference did not resolve");
            continue;
        }

        const asset: ShareAsset = {
            hash: hashAsset(found.bytes),
            absPath: found.absPath,
            vaultPath: found.rel,
            name: posix.basename(found.rel),
            kind: type.kind,
            contentType: type.contentType,
            language: type.language,
        };

        index.byTarget.set(target, asset);
        index.byHash.set(asset.hash, asset);
    }

    log.debug({ notePath, targets: targets.length, resolved: index.byHash.size }, "share asset index built");

    return index;
}

/**
 * The servable body for a hash the index knows. The file is re-read, re-checked against the vault
 * root and re-hashed, so a file swapped for a symlink or edited after indexing is refused rather than
 * served under a hash it no longer has. The hash names the file on disk; a text asset's body has its
 * secrets masked here, before any caller (panel, raw, JSON fetch) can see it.
 */
export async function readShareAsset(options: {
    vaultRoot: string;
    index: ShareAssetIndex;
    hash: string;
}): Promise<{ asset: ShareAsset; body: Buffer } | null> {
    const { vaultRoot, index, hash } = options;

    if (!SHARE_ASSET_HASH_RE.test(hash)) {
        return null;
    }

    const asset = index.byHash.get(hash);

    if (!asset) {
        return null;
    }

    const loaded = await loadCandidate(vaultRoot, await realpath(resolve(vaultRoot)), asset.vaultPath);

    if (!loaded || hashAsset(loaded.bytes) !== hash) {
        return null;
    }

    // An SVG is XML text: it is masked like the other text assets. The hash still names the bytes on disk.
    if (isMediaKind(asset.kind) && !asset.vaultPath.toLowerCase().endsWith(".svg")) {
        return { asset, body: loaded.bytes };
    }

    return { asset, body: Buffer.from(redactSecretsInText(loaded.bytes.toString("utf8")), "utf8") };
}

/** Pretty JSON as a ```json fence rendered by the note renderer, or the raw text when it does not parse. */
export function renderJsonAssetHtml(text: string): string {
    let body = text;

    try {
        body = SafeJSON.stringify(SafeJSON.parse(text, { strict: true }), null, 2);
    } catch (err) {
        log.debug({ err }, "json asset does not parse, showing it verbatim");
    }

    return renderMarkdown(fencedCode(body, "json"), { resolveWikilink: () => null }).html;
}

/**
 * A referenced note, rendered for the side panel. Its own links, images and embeds stay text, so the
 * panel never reaches a file the shared note did not reference itself.
 */
export function renderMarkdownAssetHtml(text: string): string {
    return renderMarkdown(text, { resolveWikilink: () => null, inertLocalLinks: true, lineAnchors: true }).html;
}

/** A window of at most CODE_WINDOW_LINES lines, starting a little above the requested range. */
export function renderCodeAssetHtml(options: {
    text: string;
    language: string;
    lines: { start: number; end: number } | null;
}): string {
    const { text, language, lines } = options;
    const all = text.replace(/\n$/, "").split("\n");
    const first = lines ? Math.max(1, Math.min(lines.start, all.length) - CODE_CONTEXT_LINES) : 1;
    const last = Math.min(all.length, first + CODE_WINDOW_LINES - 1);
    const code = renderCodeLines({
        code: all.slice(first - 1, last).join("\n"),
        language,
        firstLine: first,
        hit: lines ?? undefined,
    });
    const windowNote =
        first > 1 || last < all.length
            ? `<p class="dd-code-window">Lines ${first} to ${last} of ${all.length}</p>`
            : "";

    return `${windowNote}${code}`;
}

/**
 * The folder and file name a download is saved under, from the note's title: no path separator, none of the
 * characters Windows refuses, no control character, and never dots alone, so a note named `...md` cannot
 * put the ZIP's folder at `..`.
 */
export function downloadBaseName(title: string): string {
    const cleaned = title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").replace(/^[\s.]+|[\s.]+$/g, "");

    return cleaned || "note";
}

export const SHARE_BUNDLE_MAX_BYTES = 200 * 1024 * 1024;

function commonDir(paths: string[]): string {
    const dirs = paths.map((path) => {
        const dir = posix.dirname(path);

        return dir === "." ? [] : dir.split("/");
    });
    const [first = [], ...rest] = dirs;
    let length = first.length;

    for (const dir of rest) {
        let same = 0;

        while (same < length && same < dir.length && dir[same] === first[same]) {
            same++;
        }

        length = same;
    }

    return first.slice(0, length).join("/");
}

/**
 * The shared note and every file it references, as zip entries under one folder named after the note.
 * Paths keep their layout below the deepest folder they all share, so relative links and wikilinks in the
 * note still resolve after unzipping. Every attachment goes through `readShareAsset`, so the zip holds the
 * same masked bytes the page serves; one that changed since indexing is left out. Returns null when the
 * files together exceed `SHARE_BUNDLE_MAX_BYTES`.
 */
export async function buildShareBundle(options: {
    vaultRoot: string;
    index: ShareAssetIndex;
    notePath: string;
    noteText: string;
    folderName: string;
}): Promise<{ entries: Array<{ name: string; data: Uint8Array }>; skipped: number } | null> {
    const { vaultRoot, index, notePath, noteText, folderName } = options;

    if (Buffer.byteLength(noteText, "utf8") > SHARE_BUNDLE_MAX_BYTES) {
        return null;
    }

    const files: Array<{ vaultPath: string; data: Uint8Array }> = [
        { vaultPath: notePath, data: new TextEncoder().encode(noteText) },
    ];
    let total = files[0].data.length;
    let skipped = 0;

    const seenPaths = new Set<string>();

    for (const asset of index.byTarget.values()) {
        if (seenPaths.has(asset.vaultPath)) {
            continue;
        }

        seenPaths.add(asset.vaultPath);
        if (asset.vaultPath === notePath) {
            continue;
        }

        const found = await readShareAsset({
            vaultRoot,
            index: { byTarget: index.byTarget, byHash: new Map([[asset.hash, asset]]) },
            hash: asset.hash,
        });

        if (!found) {
            log.warn({ notePath, asset: asset.vaultPath }, "share bundle skipped an attachment that changed");
            skipped++;
            continue;
        }

        total += found.body.length;

        if (total > SHARE_BUNDLE_MAX_BYTES) {
            log.warn({ notePath, total }, "share bundle is over the size limit");
            return null;
        }

        files.push({ vaultPath: asset.vaultPath, data: found.body });
    }

    const base = commonDir(files.map((file) => file.vaultPath));
    const strip = base === "" ? 0 : base.length + 1;
    const entries = files.map((file) => ({ name: `${folderName}/${file.vaultPath.slice(strip)}`, data: file.data }));

    log.debug({ notePath, files: entries.length, skipped, total }, "share bundle built");

    return { entries, skipped };
}

/** The side-panel body for a text asset; `lines` narrows a code file to a window around the range. */
export function renderShareAssetFragment(
    asset: ShareAsset,
    text: string,
    lines: { start: number; end: number } | null
): string {
    if (asset.kind === "json") {
        return renderJsonAssetHtml(text);
    }

    if (asset.kind === "markdown") {
        return renderMarkdownAssetHtml(text);
    }

    return renderCodeAssetHtml({ text, language: asset.language ?? "plaintext", lines });
}

/** Key of one embedded panel: the chip's base URL and its line range, as the page script builds it. */
export function embeddedPanelKey(baseUrl: string, lines: { start: number; end: number } | null): string {
    return `${baseUrl}|${lines ? `${lines.start}-${lines.end}` : ""}`;
}

export interface ShareEmbed {
    /** Media hash (image, audio, video, PDF) to a `data:` URL holding the bytes the page would serve. */
    media: Map<string, string>;
    /** `embeddedPanelKey` to the rendered panel body and a `data:` URL of the raw file. */
    panels: Record<string, { html: string; raw: string }>;
}

function dataUrl(contentType: string, body: Buffer): string {
    return `data:${contentType.replace(/\s+/g, "")};base64,${body.toString("base64")}`;
}

/**
 * Everything a saved copy of the share page needs offline: each media file as a `data:` URL, and each text
 * asset pre-rendered once per line range the note links to. `panelBase(hash)` is the chip URL without
 * its `#L` fragment. Bodies come from `readShareAsset`, so they are masked; a changed file is left out.
 * Returns null when the files together exceed `SHARE_BUNDLE_MAX_BYTES`.
 */
export async function buildShareEmbed(options: {
    vaultRoot: string;
    index: ShareAssetIndex;
    panelBase: (hash: string) => string;
    sourceBytes: number;
}): Promise<ShareEmbed | null> {
    const { vaultRoot, index, panelBase, sourceBytes } = options;
    const embed: ShareEmbed = { media: new Map(), panels: {} };
    const bodies = new Map<string, Buffer>();
    let total = sourceBytes;

    if (total > SHARE_BUNDLE_MAX_BYTES) {
        return null;
    }

    for (const asset of index.byHash.values()) {
        const found = await readShareAsset({ vaultRoot, index, hash: asset.hash });

        if (!found) {
            log.warn({ asset: asset.vaultPath }, "share embed skipped an attachment that changed");
            continue;
        }

        total += found.body.length;

        if (total > SHARE_BUNDLE_MAX_BYTES) {
            log.warn({ total }, "share embed is over the size limit");
            return null;
        }

        bodies.set(asset.hash, found.body);

        if (isMediaKind(asset.kind)) {
            embed.media.set(asset.hash, dataUrl(asset.contentType, found.body));
        }
    }

    for (const [target, asset] of index.byTarget) {
        const body = bodies.get(asset.hash);

        if (!body || isMediaKind(asset.kind)) {
            continue;
        }

        const lines = lineRangeOf(target);
        const key = embeddedPanelKey(panelBase(asset.hash), lines);
        embed.panels[key] ??= {
            html: renderShareAssetFragment(asset, body.toString("utf8"), lines),
            raw: dataUrl(asset.contentType, body),
        };
    }

    log.debug({ media: embed.media.size, panels: Object.keys(embed.panels).length, total }, "share embed built");

    return embed;
}

const HEADING_LINE_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * The part of a note an embed shows: the whole body without frontmatter, the section under `#Heading`
 * (until the next heading of the same or a higher level), or the block that ends in `^id`.
 */
export function noteSection(text: string, fragment: string): string {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");

    if (!fragment) {
        return body;
    }

    const lines = body.split("\n");

    if (fragment.startsWith("^")) {
        const end = lines.findIndex((line) => line.trimEnd().endsWith(` ${fragment}`) || line.trim() === fragment);

        if (end === -1) {
            return "";
        }

        let start = end;

        while (start > 0 && lines[start - 1].trim() !== "") {
            start--;
        }

        return lines.slice(start, end + 1).join("\n");
    }

    const wanted = headingSlug(fragment);
    let fence: string | null = null;
    let start = -1;
    let level = 0;
    let end = lines.length;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].replace(/\r$/, "");
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
                fence = null;
            }
            continue;
        }

        if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
            fence = marker[1];
            continue;
        }

        const heading = HEADING_LINE_RE.exec(line);
        if (!heading) {
            continue;
        }

        if (start === -1 && headingSlug(heading[2]) === wanted) {
            start = index;
            level = heading[1].length;
        } else if (start !== -1 && heading[1].length <= level) {
            end = index;
            break;
        }
    }

    return start === -1 ? "" : lines.slice(start, end).join("\n");
}

/** An embedded note or section, rendered like the side panel: its own links, images and embeds stay text. */
export function renderTransclusionHtml(text: string, fragment: string, idPrefix = ""): string {
    const section = noteSection(text, fragment);

    if (!section.trim()) {
        return `<p class="dd-md-transclusion-missing">${fragment ? "This section is not in the note." : "The note is empty."}</p>`;
    }

    return renderMarkdown(section, { resolveWikilink: () => null, inertLocalLinks: true, idPrefix }).html;
}
