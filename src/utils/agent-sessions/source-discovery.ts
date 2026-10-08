import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
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

/** A directory's entries as the walk needs them. */
interface DirectoryEntry {
    name: string;
    directory: boolean;
    file: boolean;
}

/** Directories kept: every directory of every session root a resident process walks (about 25k here). */
const DIRECTORY_CACHE_LIMIT = 50_000;
const directoryCache = new Map<string, { mtimeMs: number; ino: number; entries: DirectoryEntry[] }>();

/**
 * A directory's entries, sorted by name, read again only when its modification time or inode changed: adding,
 * removing or renaming an entry changes the directory's mtime. In a resident process (the hub server, a
 * watcher) a walk of 3,942 Claude project directories costs 6 ms of `stat` instead of 74 ms of `readdir`
 * (2026-10-08), and the hub's agents tree walks twice per refresh. The stat comes before the read, so a change
 * that lands between them leaves a newer mtime and is read on the next walk; nothing is cached stale for long.
 */
async function directoryEntries(directory: string): Promise<DirectoryEntry[]> {
    const status = await stat(directory);
    const cached = directoryCache.get(directory);
    if (cached && cached.mtimeMs === status.mtimeMs && cached.ino === status.ino) {
        return cached.entries;
    }

    const read: Dirent<string>[] = await readdir(directory, { withFileTypes: true });
    read.sort((left, right) => left.name.localeCompare(right.name));
    const entries = read.map((entry) => ({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() }));
    directoryCache.delete(directory);
    directoryCache.set(directory, { mtimeMs: status.mtimeMs, ino: status.ino, entries });
    if (directoryCache.size > DIRECTORY_CACHE_LIMIT) {
        const oldest = directoryCache.keys().next().value;
        if (oldest !== undefined) {
            directoryCache.delete(oldest);
        }
    }

    return entries;
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
    let files: number | undefined;
    let issues: number | undefined;
    return profiler.scope("agent-sessions").measureAsync(
        "discover.walk",
        async () => {
            const result = await walkRoots(options);
            files = result.files.length;
            issues = result.issues.length;
            return result;
        },
        () => ({
            roots: options.roots.map((root) => root.replace(homedir(), "~")).join(","),
            files,
            issues: issues || undefined,
            maxDepth: options.maxDepth,
        })
    );
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
            // Already canonical: the root is a realpath, a plain directory entry under a canonical
            // parent is canonical, and a linked one is resolved before it is queued. A realpath
            // here cost 115 ms of CPU per grok walk (1,500 directories), and a directory that
            // vanished still fails the readdir below with the same issue.
            const canonicalDirectory = directory;
            if (seenDirectories.has(canonicalDirectory)) {
                return;
            }
            seenDirectories.add(canonicalDirectory);

            let entries: DirectoryEntry[];
            try {
                entries = await directoryEntries(canonicalDirectory);
            } catch (error) {
                complete = false;
                issues.push(discoveryIssue(canonicalDirectory, errorCategory(error, "Source directory read failed")));
                return;
            }
            for (const entry of entries) {
                options.signal?.throwIfAborted();
                // `join`, not a literal "/": this is the shared cross-platform package, and a
                // forward slash makes every discovered path stop matching the `${root}${sep}`
                // prefix the root backfill and prune use on Windows.
                const unresolved = join(canonicalDirectory, entry.name);
                let path = unresolved;
                let directoryEntry = entry.directory;
                let fileEntry = entry.file;

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
            // Four at a time, not sixteen: 830 grok readdirs cost 94 ms of kernel time at sixteen,
            // 54 ms at four and 45 ms serially (wall 22, 51 and 85 ms), and every listing walks.
            const batch = directories.slice(cursor, cursor + 4);
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
