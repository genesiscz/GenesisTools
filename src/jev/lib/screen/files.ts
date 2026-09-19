import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ScreenFile } from "./batch";
import { changedFiles, type GitDiffReader } from "./changed";

const prof = profiler.scope("jev-verify");

const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 200_000;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

export interface ScreenTargets {
    files: ScreenFile[];
    source: "stdin" | "file" | "directory";
    /** Files found beyond `--max-files`. Reported, never silently dropped. */
    truncated: number;
}

/**
 * Resolves what `screen` and `verify --against-dir` read: one file, a directory tree, or stdin.
 *
 * `--only-changed` intersects the set with `git diff --name-only`, so a repository-wide purpose
 * sweep costs one Jev batch instead of hundreds.
 */
export async function readScreenTargets(options: {
    path?: string;
    maxFiles: number;
    onlyChanged?: boolean;
    git?: GitDiffReader;
}): Promise<ScreenTargets> {
    if (!options.path || options.path === "-") {
        const text = await prof.measureAsync("read", () => Bun.stdin.text());
        logger.info({ bytes: text.length, source: "stdin" }, "Read screen input from stdin");
        return { files: [{ path: "stdin", text }], source: "stdin", truncated: 0 };
    }

    const info = await stat(options.path);

    if (info.isFile()) {
        const text = await prof.measureAsync("read", () => Bun.file(options.path as string).text());
        logger.info({ path: options.path, bytes: text.length, source: "file" }, "Read screen input from a file");
        return { files: [{ path: options.path, text }], source: "file", truncated: 0 };
    }

    const found = await prof.measureAsync("read", () => collectFiles(options.path as string, 0));
    const changed = options.onlyChanged ? new Set(changedFiles(options.path, options.git)) : undefined;
    const filtered = changed ? found.filter((path) => changed.has(path)) : found;
    const kept = filtered.slice(0, options.maxFiles);
    const truncated = filtered.length - kept.length;

    if (truncated > 0) {
        logger.warn(
            { dir: options.path, found: filtered.length, maxFiles: options.maxFiles, truncated },
            "Screen directory has more files than --max-files"
        );
    }

    const files: ScreenFile[] = [];
    for (const path of kept) {
        files.push({ path, text: await Bun.file(path).text() });
    }

    logger.info(
        {
            dir: options.path,
            found: found.length,
            afterOnlyChanged: filtered.length,
            read: files.length,
            bytes: files.reduce((total, file) => total + file.text.length, 0),
        },
        "Read screen input from a directory"
    );
    return { files, source: "directory", truncated };
}

async function collectFiles(dir: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) {
        logger.debug({ dir, depth }, "Screen directory walk hit the depth limit");
        return [];
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
            continue;
        }

        const path = join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await collectFiles(path, depth + 1)));
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const info = await stat(path);

        if (info.size === 0 || info.size > MAX_FILE_BYTES) {
            logger.debug({ path, bytes: info.size }, "Screen skipped a file outside the size window");
            continue;
        }

        files.push(path);
    }

    return files.sort();
}
