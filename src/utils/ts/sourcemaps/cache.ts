import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { withFileLock } from "@genesiscz/utils/storage";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { managedWorktree, removeBuildWorktree, type WorktreeRemoval } from "./build.ts";

const { log } = logger.scoped("ts:sourcemaps:cache");

/** Entries not used for this long are removed by the next command that writes the cache. */
export const DEFAULT_MAX_AGE_DAYS = 30;
/** An entry folder with no metadata (a failed or interrupted build) older than this is removed by prune. */
const UNFINISHED_GRACE_MS = 60 * 60 * 1000;
/** How long a metadata change waits for another process's change (a prune that removes large folders). */
const METADATA_LOCK_TIMEOUT_MS = 60_000;
/** Prune removes the managed build worktree once it has not been used this long (a command removes its own at its end). */
export const WORKTREE_IDLE_MS = 60 * 60 * 1000;

export type CacheEntryKind = "deployed" | "build";

export interface CacheEntryOrigin {
    /** Deployed entries: where the assets came from. */
    baseUrl?: string;
    /** Build entries: the checkout, commit, command and output folder that produced it. */
    repo?: string;
    commit?: string;
    buildCmd?: string;
    outputDir?: string;
}

export interface CacheEntry {
    id: string;
    kind: CacheEntryKind;
    label: string;
    createdAt: string;
    lastUsedAt: string;
    origin: CacheEntryOrigin;
    files: number;
    bytes: number;
    /** `--out` symlinks that point at this entry; pruning removes them too. */
    links: string[];
}

export interface CacheMetadata {
    version: 1;
    project: string;
    entries: Record<string, CacheEntry>;
}

export interface PrunedItem {
    /** The entry id, or `worktree` for the build worktree: a folder name in the project's cache. */
    name: string;
    reason: "unused" | "unfinished" | "idle worktree";
    /** Bytes freed; for the worktree, without the blocks it shared with clones (see `WorktreeRemoval`). */
    bytes: number;
    /** Size on disk as `du` counts it. */
    diskBytes: number;
}

export interface PruneResult {
    removed: PrunedItem[];
    /** The build worktree when it was idle past the hour and prune still left it in place, with the reason. */
    kept: WorktreeRemoval[];
}

/** `~/.genesis-tools/ts/sourcemaps`. */
export function sourcemapsRoot(): string {
    return toolDataDir("ts", "sourcemaps");
}

/** The projects that have a cache folder under `root`, sorted. */
export async function cacheProjects(root: string = sourcemapsRoot()): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        log.debug({ err: error, root }, "no sourcemaps cache yet");
        return [];
    });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

/** A folder-safe project name: lower-case letters, digits, dot, dash and underscore. */
export function projectSlug(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!slug) {
        throw new Error(`cannot derive a project name from '${name}'`);
    }

    return slug;
}

async function folderSize(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            files++;
            bytes += (await stat(join(entry.parentPath, entry.name))).size;
        }
    }

    return { files, bytes };
}

/**
 * One project's cache: `<root>/<project>/<entry id>/` folders and `<root>/<project>/metadata.json`,
 * the index of what each folder holds, so a later run can reuse a download or a build.
 */
export class SourcemapCache {
    readonly dir: string;

    constructor(
        readonly project: string,
        root: string = sourcemapsRoot()
    ) {
        this.dir = join(root, projectSlug(project));
    }

    get metadataPath(): string {
        return join(this.dir, "metadata.json");
    }

    entryDir(id: string): string {
        return join(this.dir, id);
    }

    async read(): Promise<CacheMetadata> {
        const text = await readFile(this.metadataPath, "utf8").catch((error: unknown) => {
            log.debug({ err: error, path: this.metadataPath }, "no cache metadata yet");
            return null;
        });
        if (text === null) {
            return { version: 1, project: this.project, entries: {} };
        }

        return SafeJSON.parse(text) as CacheMetadata;
    }

    /**
     * Runs one read-modify-write of the metadata under a lock shared by every process using this project's cache,
     * so two commands never both read the same index and drop each other's change. Not re-entrant.
     */
    private async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await mkdir(this.dir, { recursive: true });
        return withFileLock(join(this.dir, "metadata.lock"), fn, METADATA_LOCK_TIMEOUT_MS);
    }

    private async write(metadata: CacheMetadata): Promise<void> {
        atomicWriteFileSync(this.metadataPath, SafeJSON.stringify(metadata, null, 2));
    }

    async get(id: string): Promise<CacheEntry | null> {
        return (await this.read()).entries[id] ?? null;
    }

    /** Stops readers reusing an entry while its files are replaced; unfinished files remain prunable. */
    async invalidate(id: string): Promise<CacheEntry | undefined> {
        return this.transaction(async () => {
            const metadata = await this.read();
            const previous = metadata.entries[id];
            delete metadata.entries[id];
            await this.write(metadata);
            return previous;
        });
    }

    async list(): Promise<CacheEntry[]> {
        return Object.values((await this.read()).entries).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    }

    /**
     * Records a finished entry (its folder must already hold the files), then prunes entries unused for
     * `maxAgeDays`. Every command that writes the cache goes through here, so pruning needs no schedule.
     */
    async commit(options: {
        id: string;
        kind: CacheEntryKind;
        label: string;
        origin: CacheEntryOrigin;
        maxAgeDays?: number;
        assertValid?: () => void;
        /** The same recipe's metadata invalidated before replacing its files. */
        previous?: CacheEntry;
    }): Promise<CacheEntry> {
        const size = await folderSize(this.entryDir(options.id));
        const entry = await this.transaction(async () => {
            const metadata = await this.read();
            const now = new Date().toISOString();
            const previous = metadata.entries[options.id] ?? options.previous;
            const recorded: CacheEntry = {
                id: options.id,
                kind: options.kind,
                label: options.label,
                createdAt: previous?.createdAt ?? now,
                lastUsedAt: now,
                origin: options.origin,
                files: size.files,
                bytes: size.bytes,
                links: previous?.links ?? [],
            };
            metadata.entries[options.id] = recorded;
            // No await separates this guard from the synchronous atomic metadata write.
            options.assertValid?.();
            await this.write(metadata);
            return recorded;
        });
        await this.prune({ maxAgeDays: options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS, keep: [options.id] });
        return entry;
    }

    /** Marks an entry as used now, so pruning keeps it. */
    async touch(id: string): Promise<void> {
        await this.transaction(async () => {
            const metadata = await this.read();
            const entry = metadata.entries[id];
            if (entry) {
                entry.lastUsedAt = new Date().toISOString();
                await this.write(metadata);
            }
        });
    }

    /**
     * Makes `outPath` a symlink to the entry folder, or to `subdir` inside it (a build's `files`), so the data stays
     * in the cache and `--out` is a view of it. Refuses to replace anything that is not already a symlink.
     */
    async linkOut(id: string, outPath: string, subdir?: string): Promise<string> {
        const target = subdir ? join(this.entryDir(id), subdir) : this.entryDir(id);
        const link = resolve(outPath);
        const existing = await lstat(link).catch(() => null);
        if (existing && !existing.isSymbolicLink()) {
            throw new Error(`${link} exists and is not a symlink; pick another --out`);
        }

        if (existing) {
            await rm(link);
        }

        await mkdir(dirname(link), { recursive: true });
        await symlink(target, link, "dir");
        await this.transaction(async () => {
            const metadata = await this.read();
            let changed = false;
            // A repointed link belongs to this entry only, or pruning the entry it used to show would remove it.
            for (const other of Object.values(metadata.entries)) {
                if (other.id !== id && other.links.includes(link)) {
                    other.links = other.links.filter((path) => path !== link);
                    changed = true;
                }
            }

            const entry = metadata.entries[id];
            if (entry && !entry.links.includes(link)) {
                entry.links.push(link);
                changed = true;
            }

            if (changed) {
                await this.write(metadata);
            }
        });
        return link;
    }

    /** The entry's folder itself or a path inside it, with either separator (Windows paths use \\). */
    private isInside(path: string, id: string): boolean {
        const rel = relative(this.entryDir(id), path);
        return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
    }

    /** Where a symlink points, resolved against its own folder. */
    private async linkTarget(link: string): Promise<string> {
        return resolve(dirname(link), await readlink(link));
    }

    /**
     * Removes entries (folder, metadata row, `--out` symlinks) unused for `maxAgeDays`, folders that failed builds
     * left, and the managed build worktree once it has been idle for `WORKTREE_IDLE_MS`.
     */
    async prune(options: { maxAgeDays?: number; keep?: string[] } = {}): Promise<PruneResult> {
        const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
        // NaN compares false against every age, so an unparsed value would remove every entry.
        if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
            throw new RangeError(`maxAgeDays must be a number of days, 0 or more; got ${maxAgeDays}`);
        }

        return profiler.scope("sourcemaps").measureAsync("cache.prune", async () => {
            const removed = await this.transaction(() => this.pruneNow(options));
            // Outside the metadata lock: removing a worktree with its dependencies takes seconds.
            const worktree = await removeBuildWorktree({
                cache: this,
                worktree: managedWorktree(this),
                idleMs: WORKTREE_IDLE_MS,
            });
            if (worktree.outcome === "removed") {
                removed.push({
                    name: relative(this.dir, worktree.worktree),
                    reason: "idle worktree",
                    bytes: worktree.bytes,
                    diskBytes: worktree.diskBytes ?? worktree.bytes,
                });
            }

            const quiet =
                worktree.outcome === "removed" || worktree.outcome === "absent" || worktree.outcome === "recent";
            return { removed, kept: quiet ? [] : [worktree] };
        });
    }

    private async pruneNow(options: { maxAgeDays?: number; keep?: string[] }): Promise<PrunedItem[]> {
        const maxAgeMs = (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000;
        const metadata = await this.read();
        const removed: PrunedItem[] = [];
        for (const entry of Object.values(metadata.entries)) {
            if (options.keep?.includes(entry.id) || Date.now() - Date.parse(entry.lastUsedAt) < maxAgeMs) {
                continue;
            }

            for (const link of entry.links) {
                const linkStat = await lstat(link).catch(() => null);
                if (linkStat?.isSymbolicLink() && this.isInside(await this.linkTarget(link), entry.id)) {
                    await rm(link);
                }
            }

            await rm(this.entryDir(entry.id), { recursive: true, force: true });
            delete metadata.entries[entry.id];
            removed.push({ name: entry.id, reason: "unused", bytes: entry.bytes, diskBytes: entry.bytes });
        }

        // A build or fetch that failed or was interrupted leaves its folder without a metadata entry. Such a
        // folder is never reused (the next run starts it over), so it only holds disk. The grace period keeps
        // a build that is running right now.
        const unfinished: PrunedItem[] = [];
        for (const name of await readdir(this.dir).catch(() => [] as string[])) {
            if (!/^(build|deployed)-/.test(name) || metadata.entries[name] || options.keep?.includes(name)) {
                continue;
            }

            const folder = await stat(this.entryDir(name)).catch(() => null);
            if (folder?.isDirectory() && Date.now() - folder.mtimeMs > UNFINISHED_GRACE_MS) {
                const size = await folderSize(this.entryDir(name));
                await rm(this.entryDir(name), { recursive: true, force: true });
                unfinished.push({ name, reason: "unfinished", bytes: size.bytes, diskBytes: size.bytes });
            }
        }

        if (removed.length > 0 || unfinished.length > 0) {
            log.info({ project: this.project, removed, unfinished }, "pruned sourcemap cache entries");
            await this.write(metadata);
        }

        return [...removed, ...unfinished];
    }
}
