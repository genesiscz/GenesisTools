import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { profiler } from "@genesiscz/utils/profile";
import type { NativeSourceIssue } from "./types";

export type { HistoryDiscoveryOptions } from "./types";

export interface DiscoveredSourceFile {
    root: string;
    path: string;
    relativePath: string;
}

export interface WalkSourceRootsResult {
    files: DiscoveredSourceFile[];
    issues: NativeSourceIssue[];
    completeRoots: string[];
}

export interface WalkSourceRootsOptions {
    roots: string[];
    filtered?: boolean;
    signal?: AbortSignal;
    maxDepth?: number;
    shouldDescend?: (entry: { root: string; path: string; relativePath: string; depth: number }) => boolean;
    includeFile?: (entry: DiscoveredSourceFile) => boolean;
}

function discoveryIssue(path: string, message: string): NativeSourceIssue {
    return { path, message };
}

function errorCategory(error: unknown, fallback: string, missing = fallback): string {
    if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT") {
            return missing;
        }
        if (error.code === "EACCES" || error.code === "EPERM") {
            return "Source discovery permission denied";
        }
    }
    return fallback;
}

/**
 * The syscall floor under every provider's discovery: claude, codex and grok all reach it, so one
 * timer here prices the whole corpus scan.
 */
export async function walkSourceRoots(options: WalkSourceRootsOptions): Promise<WalkSourceRootsResult> {
    return profiler.scope("agent-sessions").measureAsync("discover.walk", () => walkRoots(options));
}

async function walkRoots(options: WalkSourceRootsOptions): Promise<WalkSourceRootsResult> {
    const files: DiscoveredSourceFile[] = [];
    const issues: NativeSourceIssue[] = [];
    const completeRoots: string[] = [];
    const seenRoots = new Set<string>();
    const seenDirectories = new Set<string>();
    const seenFiles = new Set<string>();

    for (const inputRoot of options.roots) {
        options.signal?.throwIfAborted();
        let root: string;
        try {
            root = await realpath(inputRoot);
        } catch (error) {
            issues.push({
                ...discoveryIssue(
                    inputRoot,
                    errorCategory(error, "Source root read failed", "Source root unavailable")
                ),
                ...(error instanceof Error && "code" in error && error.code === "ENOENT"
                    ? { code: "root-missing" as const }
                    : {}),
            });
            continue;
        }
        if (seenRoots.has(root)) {
            continue;
        }
        seenRoots.add(root);
        let complete = !options.filtered;
        const directories: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

        async function visit(directory: string, depth: number): Promise<void> {
            options.signal?.throwIfAborted();
            let canonicalDirectory: string;
            try {
                canonicalDirectory = await realpath(directory);
            } catch (error) {
                complete = false;
                issues.push(discoveryIssue(directory, errorCategory(error, "Source directory read failed")));
                return;
            }
            if (seenDirectories.has(canonicalDirectory)) {
                return;
            }
            seenDirectories.add(canonicalDirectory);

            let entries: Dirent<string>[];
            try {
                entries = await readdir(canonicalDirectory, { withFileTypes: true });
            } catch (error) {
                complete = false;
                issues.push(discoveryIssue(canonicalDirectory, errorCategory(error, "Source directory read failed")));
                return;
            }
            entries.sort((left, right) => left.name.localeCompare(right.name));
            for (const entry of entries) {
                options.signal?.throwIfAborted();
                // `join`, not a literal "/": this is the shared cross-platform package, and a
                // forward slash makes every discovered path stop matching the `${root}${sep}`
                // prefix the root backfill and prune use on Windows.
                const unresolved = join(canonicalDirectory, entry.name);
                let path = unresolved;
                let directoryEntry = entry.isDirectory();
                let fileEntry = entry.isFile();

                // Dirent already identifies ordinary files/directories. Resolve links (and unknown
                // directory-entry types) explicitly without two extra syscalls per transcript.
                if (!directoryEntry && !fileEntry) {
                    try {
                        path = await realpath(unresolved);
                        const entryStat = await stat(path);
                        directoryEntry = entryStat.isDirectory();
                        fileEntry = entryStat.isFile();
                    } catch (error) {
                        complete = false;
                        issues.push(discoveryIssue(unresolved, errorCategory(error, "Source entry read failed")));
                        continue;
                    }
                }

                const relativePath = relative(root, path);
                if (directoryEntry) {
                    const nextDepth = depth + 1;
                    if (options.maxDepth !== undefined && nextDepth > options.maxDepth) {
                        complete = false;
                        continue;
                    }
                    if (
                        options.shouldDescend &&
                        !options.shouldDescend({ root, path, relativePath, depth: nextDepth })
                    ) {
                        complete = false;
                        continue;
                    }
                    directories.push({ directory: path, depth: nextDepth });
                    continue;
                }
                if (!fileEntry || seenFiles.has(path)) {
                    continue;
                }
                seenFiles.add(path);
                const file = { root, path, relativePath };
                if (!options.includeFile || options.includeFile(file)) {
                    files.push(file);
                }
            }
        }

        for (let cursor = 0; cursor < directories.length; ) {
            options.signal?.throwIfAborted();
            const batch = directories.slice(cursor, cursor + 16);
            cursor += batch.length;
            await Promise.all(batch.map(({ directory, depth }) => visit(directory, depth)));
        }

        if (complete) {
            completeRoots.push(root);
        }
    }

    files.sort((left, right) => left.root.localeCompare(right.root) || left.path.localeCompare(right.path));
    issues.sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
    return { files, issues, completeRoots };
}
