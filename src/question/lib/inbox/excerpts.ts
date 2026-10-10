import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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

interface ReadDeps {
    read: (path: string) => string;
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

const realDeps: ReadDeps = {
    read: (path) => readFileSync(path, "utf8"),
    isFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
    roots: sessionRoots,
    files: listFiles,
};

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

/** One ref filled with the real lines from disk, its language and a start line; `missing` when unreadable. */
function fillRef(ref: InboxRef, cwd: string | undefined, deps: ReadDeps): InboxRef {
    const location = locateRef(ref.path, cwd, deps);
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
        const lines = deps.read(absolute).split("\n");
        const start = Math.max(1, ref.line - BEFORE);
        const end = Math.min(
            lines.length,
            ref.endLine ? Math.min(ref.endLine, ref.line + MAX_LINES - 1) : ref.line + AFTER
        );
        const excerpt = lines
            .slice(start - 1, end)
            .join("\n")
            .slice(0, MAX_CHARS);

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
