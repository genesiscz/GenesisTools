import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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

/** The absolute path of a ref: an absolute path as-is, else resolved against the session's folder. */
function absoluteOf(path: string, cwd: string | undefined): string | null {
    if (isAbsolute(path)) {
        return path;
    }

    if (!cwd) {
        return null;
    }

    return resolve(cwd, path);
}

interface ReadDeps {
    read: (path: string) => string;
}

const realDeps: ReadDeps = { read: (path) => readFileSync(path, "utf8") };

/** One ref filled with the real lines from disk, its language and a start line; `missing` when unreadable. */
function fillRef(ref: InboxRef, cwd: string | undefined, deps: ReadDeps): InboxRef {
    const absolute = absoluteOf(ref.path, cwd);
    const base: InboxRef = { ...ref, absolute, language: languageOf(ref.path) };

    if (!absolute || ref.line === null) {
        return { ...base, excerpt: null, startLine: ref.line, missing: absolute === null };
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
