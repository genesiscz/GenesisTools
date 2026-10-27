import { type Dirent, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { profiler } from "@genesiscz/utils/profile";
import { historyPathUnderRoot } from "./project-scope";
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
    /** Direct logical paths; external canonical paths get a capped root-link probe. No complete root or tree walk. */
    filePaths?: string[];
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
    symlink: boolean;
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
    // `statSync`: the async `stat` cost about four times the CPU, and a warm walk is a stat per folder (4,572 here).
    const status = statSync(directory);
    const cached = directoryCache.get(directory);
    const settled = Date.now() - status.mtimeMs >= 2000;
    if (settled && cached && cached.mtimeMs === status.mtimeMs && cached.ino === status.ino) {
        return cached.entries;
    }

    const read: Dirent<string>[] = await readdir(directory, { withFileTypes: true });
    read.sort((left, right) => left.name.localeCompare(right.name));
    const entries = read.map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
        file: entry.isFile(),
        symlink: entry.isSymbolicLink(),
    }));
    directoryCache.delete(directory);
    if (!settled) {
        return entries;
    }

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
    if (options.filePaths !== undefined) {
        return sourceFilesForPaths({ ...options, filePaths: options.filePaths });
    }

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

/**
 * `join(directory, name)` and `relative(root, path)` for the walk's plain entries, without normalizing: the directory
 * is canonical and a directory entry's name holds no separator. The two calls were a third of a listing's
 * rediscovery (13,000 entries, 2026-10-08). A path outside `root` (a resolved link) still goes through `relative`.
 */
function childPath(directory: string, name: string): string {
    return directory.endsWith(sep) ? `${directory}${name}` : `${directory}${sep}${name}`;
}

function relativeToRoot(root: string, path: string): string {
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : relative(root, path);
}

const EXACT_LINK_ROOT_LIMIT = 32;
const EXACT_LINK_LIMIT = 128;

async function exactFile({
    root,
    logicalPath,
    path,
    options,
}: {
    root: string;
    logicalPath: string;
    path: string;
    options: WalkSourceRootsOptions;
}): Promise<DiscoveredSourceFile | undefined> {
    const parts = relative(root, logicalPath).split(sep);
    if (options.maxDepth !== undefined && parts.length - 1 > options.maxDepth) {
        return;
    }

    if (options.shouldDescend) {
        for (let depth = 1; depth < parts.length; depth++) {
            options.signal?.throwIfAborted();
            const directory = await realpath(join(root, ...parts.slice(0, depth)));
            if (
                !options.shouldDescend({ root, path: directory, relativePath: relativeToRoot(root, directory), depth })
            ) {
                return;
            }
        }
    }

    const file = { root, path, relativePath: relativeToRoot(root, path) };
    return !options.includeFile || options.includeFile(file) ? file : undefined;
}

/** Only root-level links are probed. Ordinary directories and link targets are never enumerated. */
async function filesThroughRootLinks({
    roots,
    targets,
    options,
    issues,
}: {
    roots: Iterable<string>;
    targets: Set<string>;
    options: WalkSourceRootsOptions;
    issues: NativeSourceIssue[];
}): Promise<DiscoveredSourceFile[]> {
    const files: DiscoveredSourceFile[] = [];
    let rootReads = 0;
    let linkReads = 0;
    for (const root of roots) {
        options.signal?.throwIfAborted();
        if (targets.size === 0) {
            break;
        }

        if (rootReads === EXACT_LINK_ROOT_LIMIT) {
            issues.push({
                path: root,
                message: `Exact-path link lookup stopped at ${EXACT_LINK_ROOT_LIMIT} roots; use a normal history refresh for remaining links`,
            });
            break;
        }

        rootReads++;
        let entries: DirectoryEntry[];
        try {
            entries = await directoryEntries(root);
        } catch (error) {
            issues.push(discoveryIssue(root, errorCategory(error, "Source directory read failed")));
            continue;
        }

        for (const entry of entries) {
            if (!entry.symlink) {
                continue;
            }

            options.signal?.throwIfAborted();
            if (targets.size === 0) {
                break;
            }

            if (linkReads === EXACT_LINK_LIMIT) {
                issues.push({
                    path: root,
                    message: `Exact-path link lookup stopped at ${EXACT_LINK_LIMIT} links; use a normal history refresh for remaining links`,
                });
                return files;
            }

            linkReads++;
            const link = childPath(root, entry.name);
            try {
                const destination = await realpath(link);
                const status = await stat(destination);
                for (const path of targets) {
                    const throughFile = status.isFile() && destination === path;
                    const throughDirectory =
                        status.isDirectory() && historyPathUnderRoot(path, destination) && path !== destination;
                    if (!throughFile && !throughDirectory) {
                        continue;
                    }

                    const logicalPath = throughFile ? link : join(link, relative(destination, path));
                    if ((await realpath(logicalPath)) !== path) {
                        continue;
                    }

                    const file = await exactFile({ root, logicalPath, path, options });
                    if (file) {
                        files.push(file);
                        targets.delete(path);
                    }
                }
            } catch (error) {
                options.signal?.throwIfAborted();
                issues.push(discoveryIssue(link, errorCategory(error, "Source entry read failed")));
            }
        }
    }

    return files;
}

/** Exact paths never start a tree walk: logical links are direct, unknown external targets get a capped root probe. */
async function sourceFilesForPaths(
    options: WalkSourceRootsOptions & { filePaths: string[] }
): Promise<WalkSourceRootsResult> {
    const files: DiscoveredSourceFile[] = [];
    const issues: NativeSourceIssue[] = [];
    if (options.filePaths.length === 0) {
        return { files, issues, completeRoots: [] };
    }

    const roots = new Map<string, string>();
    for (const inputRoot of options.roots) {
        options.signal?.throwIfAborted();
        try {
            roots.set(resolve(inputRoot), await realpath(inputRoot));
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
        }
    }

    const canonicalRoots = new Set(roots.values());
    const seen = new Set<string>();
    const external = new Set<string>();
    for (const inputPath of new Set(options.filePaths)) {
        options.signal?.throwIfAborted();
        try {
            const path = await realpath(inputPath);
            if (seen.has(path) || !(await stat(path)).isFile()) {
                continue;
            }

            const logical = resolve(inputPath);
            const logicalRoot = [...roots].find(([candidate]) => historyPathUnderRoot(logical, candidate));
            const root =
                logicalRoot?.[1] ?? [...canonicalRoots].find((candidate) => historyPathUnderRoot(path, candidate));
            if (!root) {
                external.add(path);
                continue;
            }

            const logicalPath = logicalRoot ? join(root, relative(logicalRoot[0], logical)) : path;
            const file = await exactFile({ root, logicalPath, path, options });
            if (file) {
                seen.add(path);
                external.delete(path);
                files.push(file);
            }
        } catch (error) {
            options.signal?.throwIfAborted();
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                issues.push(discoveryIssue(inputPath, errorCategory(error, "Source entry read failed")));
            }
        }
    }

    if (external.size > 0) {
        files.push(...(await filesThroughRootLinks({ roots: canonicalRoots, targets: external, options, issues })));
    }

    files.sort((left, right) => left.root.localeCompare(right.root) || left.path.localeCompare(right.path));
    issues.sort((left, right) => left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
    return { files, issues, completeRoots: [] };
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
                // `sep`, not a literal "/": this is the shared cross-platform package, and a
                // forward slash makes every discovered path stop matching the `${root}${sep}`
                // prefix the root backfill and prune use on Windows.
                const unresolved = childPath(canonicalDirectory, entry.name);
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

                const relativePath = relativeToRoot(root, path);
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
