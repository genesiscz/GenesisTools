import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findProjectRoot } from "@genesiscz/utils/fs/project-root";
import { checkoutsAt } from "@genesiscz/utils/git/local-checkouts";
import { logger } from "@genesiscz/utils/logger";
import type { InboxRef } from "./build";

const { log } = logger.scoped("question-inbox");

/** Lines read above a single-line ref, and below it. A range reads from its first line. */
const BEFORE = 3;
const AFTER = 6;
const MAX_LINES = 40;
const MAX_CHARS = 8_000;
/** No decision points at more files than this; a runaway reply cannot make the loader read the disk forever. */
const MAX_REFS = 12;
/** A cited line further into its file than this is not read: one excerpt never reads more of the disk than this. */
const MAX_READ_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const LANGUAGE: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    swift: "swift",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    java: "java",
    kt: "kotlin",
    php: "php",
    sh: "bash",
    zsh: "bash",
    json: "json",
    jsonc: "json",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    css: "css",
    html: "html",
    sql: "sql",
};

function languageOf(path: string): string | null {
    const ext = path.split(".").pop()?.toLowerCase();
    return (ext && LANGUAGE[ext]) ?? null;
}

/** A file list older than this is read again; one inbox load asks for the same checkout many times. */
const FILES_TTL_MS = 60_000;
/** A checkout with more files than this is not searched by suffix (a home folder, a monorepo of vendored trees). */
const MAX_FILES = 200_000;

/** Lines `from` to `to` of a file, counted from 1, both included. */
interface LineWindow {
    from: number;
    to: number;
}

interface ReadDeps {
    /**
     * Lines `from` to `to` of the file at `path`, joined and cut at MAX_CHARS. It reads from the start of the file no
     * further than line `to`, and never past MAX_READ_BYTES, so a large file costs its first lines only.
     */
    excerpt: (path: string, window: LineWindow) => string;
    /** Whether a regular file is at `path`. */
    isFile: (path: string) => boolean;
    /** The folders a relative ref is tried against, most specific first: the session's folder, its checkout, the main checkout. */
    roots: (cwd: string) => string[];
    /** Every file of the checkout at `root` (tracked and untracked, not ignored), relative to it; null when it is not one. */
    files: (root: string) => readonly string[] | null;
}

const listings = new Map<string, { at: number; files: readonly string[] | null }>();

function listFiles(root: string): readonly string[] | null {
    const cached = listings.get(root);

    if (cached && Date.now() - cached.at < FILES_TTL_MS) {
        return cached.files;
    }

    let files: readonly string[] | null = null;

    try {
        const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
            encoding: "utf8",
            timeout: 3_000,
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const all = out.split("\0").filter(Boolean);
        files = all.length > MAX_FILES ? null : all;
        log.debug({ root, files: all.length, searched: files !== null }, "inbox: listed a checkout for ref lookup");
    } catch (error) {
        log.debug({ error, root }, "inbox: a ref root could not be listed");
    }

    listings.set(root, { at: Date.now(), files });
    return files;
}

function sessionRoots(cwd: string): string[] {
    const project = findProjectRoot(cwd);
    const main = project ? checkoutsAt(project).find((checkout) => checkout.isMain)?.root : undefined;
    return [...new Set([cwd, project, main].filter((root): root is string => Boolean(root)))];
}

/**
 * The real `excerpt` reader: the file's head, chunk by chunk, until line `to` ends or `maxBytes` are read. A line
 * the budget cuts is left out, so the excerpt ends at the last whole line before it, and the cut is logged.
 */
export function readExcerpt(
    path: string,
    { from, to, maxBytes = MAX_READ_BYTES }: LineWindow & { maxBytes?: number }
): string {
    if (to < from) {
        return "";
    }

    const fd = openSync(path, "r");

    try {
        const total = fstatSync(fd).size;
        const budget = Math.min(total, maxBytes);
        const chunks: Buffer[] = [];
        let size = 0;
        let newlines = 0;

        while (newlines < to && size < budget) {
            const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, budget - size));
            const read = readSync(fd, chunk, 0, chunk.length, size);

            if (read === 0) {
                break;
            }

            const part = chunk.subarray(0, read);
            chunks.push(part);
            size += read;

            for (let at = part.indexOf(10); at !== -1; at = part.indexOf(10, at + 1)) {
                newlines++;
            }
        }

        const lines = Buffer.concat(chunks, size).toString("utf8").split("\n");

        if (newlines < to && size < total) {
            log.debug(
                { path, to, maxBytes, total },
                "inbox: a cited line lies past the read budget; the excerpt ends before it"
            );
            lines.length = newlines;
        }

        return lines
            .slice(from - 1, to)
            .join("\n")
            .slice(0, MAX_CHARS);
    } finally {
        closeSync(fd);
    }
}

const realDeps: ReadDeps = {
    excerpt: (path, window) => readExcerpt(path, window),
    isFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
    roots: sessionRoots,
    files: listFiles,
};

/**
 * Excerpts a caching reader keeps (one per file and line window, each at most MAX_CHARS), and session folders whose
 * roots it keeps; past it the oldest goes.
 */
const CACHED_EXCERPTS = 128;
const CACHED_ROOTS = 64;

/** What a file's text depends on: its size and modification time; null when no regular file is there. */
function fileStamp(path: string): string | null {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat?.isFile() ? `${stat.size}:${stat.mtimeMs}` : null;
}

/** Puts `key` last (the newest) in `map`, and drops the oldest entry once the map holds more than `limit`. */
function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
    map.delete(key);
    map.set(key, value);

    if (map.size > limit) {
        const oldest = map.keys().next();

        if (!oldest.done) {
            map.delete(oldest.value);
        }
    }
}

/**
 * `base` with a memory, for a caller that fills the same refs again every few seconds (the widget snapshot): an
 * excerpt is read again only when its file's size or modification time changed, and a folder's roots are looked up
 * again after FILES_TTL_MS, as a checkout's file list is. It keeps the excerpts, never a file's whole text, so a large
 * cited file costs one bounded read per change. The stamp is taken before the read, so a file changed during the read
 * gets a new stamp and is read again next time.
 */
export function cachingReadDeps({
    base = realDeps,
    stamp = fileStamp,
    now = Date.now,
}: {
    base?: ReadDeps;
    stamp?: (path: string) => string | null;
    now?: () => number;
} = {}): ReadDeps {
    const excerpts = new Map<string, { stamp: string; text: string }>();
    const roots = new Map<string, { at: number; roots: string[] }>();

    return {
        ...base,
        excerpt: (path, window) => {
            const key = `${path}\0${window.from}\0${window.to}`;
            const current = stamp(path);
            const cached = excerpts.get(key);

            if (current !== null && cached?.stamp === current) {
                remember(excerpts, key, cached, CACHED_EXCERPTS);
                return cached.text;
            }

            excerpts.delete(key);
            const text = base.excerpt(path, window);

            if (current !== null) {
                remember(excerpts, key, { stamp: current, text }, CACHED_EXCERPTS);
            }

            return text;
        },
        roots: (cwd) => {
            const cached = roots.get(cwd);

            if (cached && now() - cached.at < FILES_TTL_MS) {
                return cached.roots;
            }

            const found = base.roots(cwd);
            remember(roots, cwd, { at: now(), roots: found }, CACHED_ROOTS);
            return found;
        },
    };
}

/** What a traced read reports: each path before it is read, and a lookup it cannot re-check cheaply. */
export interface ExcerptTrace {
    probe: (path: string) => void;
    cannotProve: (reason: string) => void;
}

/**
 * The real reads, each reported to `trace` first (the inbox cursor re-checks them). The roots depend on the `.git`
 * markers from the session folder up to its checkout root, so those are reported too; a search of a checkout's file
 * list depends on every file in it and cannot be re-checked.
 */
export function tracedReadDeps(trace: ExcerptTrace): ReadDeps {
    return {
        excerpt: (path, window) => {
            trace.probe(path);
            return realDeps.excerpt(path, window);
        },
        isFile: (path) => {
            trace.probe(path);
            return realDeps.isFile(path);
        },
        roots: (cwd) => {
            let dir = resolve(cwd);

            for (;;) {
                const marker = join(dir, ".git");
                trace.probe(marker);
                const parent = dirname(dir);

                if (existsSync(marker) || parent === dir) {
                    break;
                }

                dir = parent;
            }

            return realDeps.roots(cwd);
        },
        files: (root) => {
            trace.cannotProve(`a ref was looked up in the file list of ${root}`);
            return realDeps.files(root);
        },
    };
}

/** Where a ref points: the file, or the folders that were searched and how many files matched there. */
interface RefLocation {
    absolute: string | null;
    searched: string[];
    matches: number;
}

/**
 * The file a ref names. An absolute path is taken as-is. A relative one is tried against the session's
 * folder, its checkout's root and the main checkout; then by suffix in each checkout's file list, where
 * exactly one match wins ("CheckoutRoute.tsx:18" from a session in the repo root, the file four folders down).
 */
export function locateRef(
    path: string,
    cwd: string | undefined,
    deps: Pick<ReadDeps, "isFile" | "roots" | "files"> = realDeps
): RefLocation {
    const clean = path.replace(/^\.\//, "");

    if (isAbsolute(clean)) {
        return { absolute: clean, searched: [], matches: deps.isFile(clean) ? 1 : 0 };
    }

    if (!cwd) {
        return { absolute: null, searched: [], matches: 0 };
    }

    const roots = deps.roots(cwd);

    for (const root of roots) {
        const candidate = resolve(root, clean);

        if (deps.isFile(candidate)) {
            return { absolute: candidate, searched: roots, matches: 1 };
        }
    }

    const suffix = `/${clean}`;

    for (const root of roots) {
        const hits = (deps.files(root) ?? []).filter((file) => file === clean || file.endsWith(suffix));

        if (hits.length === 1) {
            return { absolute: resolve(root, hits[0]), searched: roots, matches: 1 };
        }

        if (hits.length > 1) {
            log.debug({ path, root, matches: hits.length }, "inbox: a ref matches several files");
            return { absolute: null, searched: [root], matches: hits.length };
        }
    }

    return { absolute: null, searched: roots, matches: 0 };
}

/** Where a ref points, or nowhere when looking fails: one unreadable folder must not fail the whole inbox. */
function tryLocateRef(ref: InboxRef, cwd: string | undefined, deps: ReadDeps): RefLocation {
    try {
        return locateRef(ref.path, cwd, deps);
    } catch (error) {
        // statSync throws past `throwIfNoEntry` for EACCES, ENOTDIR and a symlink loop; a root lookup can throw too.
        log.debug({ error, path: ref.path, cwd }, "inbox: a decision's ref could not be located");
        return { absolute: null, searched: [], matches: 0 };
    }
}

/** One ref filled with the real lines from disk, its language and a start line; `missing` when unreadable. */
function fillRef(ref: InboxRef, cwd: string | undefined, deps: ReadDeps): InboxRef {
    const location = tryLocateRef(ref, cwd, deps);
    const absolute = location.absolute;
    const found = absolute !== null && location.matches === 1;
    const base: InboxRef = {
        ...ref,
        absolute,
        language: languageOf(ref.path),
        searched: location.searched,
        matches: location.matches,
    };

    if (!found || ref.line === null) {
        return { ...base, excerpt: null, startLine: ref.line, missing: !found };
    }

    try {
        const start = Math.max(1, ref.line - BEFORE);
        const end = ref.endLine ? Math.min(ref.endLine, ref.line + MAX_LINES - 1) : ref.line + AFTER;
        const excerpt = deps.excerpt(absolute, { from: start, to: end });

        return { ...base, excerpt: excerpt.length > 0 ? excerpt : null, startLine: start, missing: false };
    } catch (error) {
        log.debug({ error, path: absolute }, "inbox: a decision's ref could not be read");
        return { ...base, excerpt: null, startLine: ref.line, missing: true };
    }
}

/** Fills every ref of a decision with its real lines (bounded), off the caller's hot path. Pure over `deps`. */
export function fillExcerpts(
    refs: readonly InboxRef[],
    cwd: string | undefined,
    deps: ReadDeps = realDeps
): InboxRef[] {
    return refs.slice(0, MAX_REFS).map((ref) => fillRef(ref, cwd, deps));
}

/**
 * The refs a decision card draws: `fillExcerpts`, without the refs that have nothing to show (a file found but named
 * without a line). The hub's Swift card filters the same way (`DecisionRef.hasContent`).
 */
export function shownExcerpts(
    refs: readonly InboxRef[],
    cwd: string | undefined,
    deps: ReadDeps = realDeps
): InboxRef[] {
    return fillExcerpts(refs, cwd, deps).filter((ref) => (ref.excerpt?.length ?? 0) > 0 || ref.missing);
}
