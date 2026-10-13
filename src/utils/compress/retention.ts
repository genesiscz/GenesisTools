import { existsSync, lstatSync, readdirSync, rmSync, statfsSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { logger } from "@genesiscz/utils/logger";
import { assertTestSafePath } from "@genesiscz/utils/storage/real-home-guard";
import { compressFile, digestZstdContent, sourceUnchanged, verifyCompressedFile } from "./file";
import { recordCompression } from "./ledger";
import { type CompressPreset, PRESETS } from "./presets";
import { archiveBaseName, FOLDER_ARCHIVE_SUFFIX, packDirectory, verifyArchiveAgainstFolder } from "./tar";
import { ZSTD_SUFFIX } from "./zstd";

const DAY_MS = 86_400_000;
/** A temp file from an interrupted write is removed once it is this old (no live writer takes that long). */
const STALE_TEMP_MS = DAY_MS;
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;

/** Removes a path for good (the default way retention retires a folder, an archive or a plain file). */
export function removePath(path: string): void {
    assertTestSafePath(path, "remove");
    rmSync(path, { recursive: true, force: true });
}

function freeBytes(path: string): number {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
}

// ── folders: keep the newest N, pack the rest ────────────────────────────────────────────────────────────────────

export interface FolderRetentionOptions {
    root: string;
    /** The newest folders kept as they are (quick rollback). */
    keep: number;
    /**
     * A kept folder older than this is packed anyway: a month-old rollback copy is rarely worth its full size. Needed
     * where the runs are APFS clones of each other (`cp -c` backups): removing one run while a newer clone of the same
     * data stays frees almost nothing, so only packing the old ones together reclaims space.
     */
    keepMaxAgeDays?: number;
    /** Archives whose folder is older than this are deleted. Unset: never by age. */
    maxArchiveAgeDays?: number;
    /** At most this many archives stay, newest first. Unset: no count cap. */
    maxArchives?: number;
    /** Which folders take part; default: every folder whose name does not start with a dot. */
    include?: (name: string) => boolean;
    /** Folders that stay as they are whatever their age or rank (a running process uses them). */
    pin?: (name: string) => boolean;
    /**
     * When a folder (or the folder an archive was made from) was made, in ms. Default: the folder's mtime, which an
     * archive inherits. Pass a name parser when names carry the time (`<epoch ms>`, `<YYYYMMDD-HHMMSS>`).
     */
    timeOf?: (entry: { name: string; mtimeMs: number }) => number;
    now?: Date;
}

export interface PlannedPack {
    folder: string;
    archive: string;
    timeMs: number;
}

export interface FolderRetentionPlan {
    root: string;
    kept: string[];
    pack: PlannedPack[];
    /** Folders already past the archive limits: removed without an archive. */
    drop: string[];
    deleteArchives: string[];
    staleTemps: string[];
}

/** What a retention run would do. Reads only: this is the dry run. */
export function planFolderRetention(options: FolderRetentionOptions): FolderRetentionPlan {
    const { root, keep, keepMaxAgeDays, maxArchiveAgeDays, maxArchives } = options;
    const include = options.include ?? ((name: string) => !name.startsWith("."));
    const timeOf = options.timeOf ?? ((entry: { mtimeMs: number }) => entry.mtimeMs);
    const now = (options.now ?? new Date()).getTime();
    const plan: FolderRetentionPlan = { root, kept: [], pack: [], drop: [], deleteArchives: [], staleTemps: [] };

    if (!existsSync(root)) {
        return plan;
    }

    const folders: Array<{ path: string; timeMs: number; name: string }> = [];
    const archives: Array<{ path: string; timeMs: number; folder?: string }> = [];

    for (const dirent of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, dirent.name);

        if (dirent.name.endsWith(".tmp")) {
            if (now - lstatSync(path).mtimeMs > STALE_TEMP_MS) {
                plan.staleTemps.push(path);
            }

            continue;
        }

        if (dirent.isFile() && dirent.name.endsWith(FOLDER_ARCHIVE_SUFFIX)) {
            const name = archiveBaseName(dirent.name);
            archives.push({ path, timeMs: timeOf({ name, mtimeMs: lstatSync(path).mtimeMs }) });
            continue;
        }

        if (dirent.isDirectory() && include(dirent.name)) {
            folders.push({
                path,
                name: dirent.name,
                timeMs: timeOf({ name: dirent.name, mtimeMs: lstatSync(path).mtimeMs }),
            });
        }
    }

    folders.sort((a, b) => b.timeMs - a.timeMs || b.name.localeCompare(a.name));
    const pinned = options.pin ?? (() => false);
    const keepable = (folder: { timeMs: number; name: string }, index: number) =>
        pinned(folder.name) ||
        (index < keep && (keepMaxAgeDays === undefined || now - folder.timeMs <= keepMaxAgeDays * DAY_MS));
    plan.kept = folders.filter(keepable).map((folder) => folder.path);
    const older = folders.filter((folder, index) => !keepable(folder, index));
    const repacked = new Set(older.map((folder) => `${folder.path}${FOLDER_ARCHIVE_SUFFIX}`));
    // A folder and its own archive both present means an earlier run stopped between packing and removing: the
    // folder is packed again (the rename replaces the archive), so the archive is not counted twice.
    const candidates = [
        ...archives.filter((archive) => !repacked.has(archive.path)),
        ...older.map((folder) => ({
            path: `${folder.path}${FOLDER_ARCHIVE_SUFFIX}`,
            timeMs: folder.timeMs,
            folder: folder.path,
        })),
    ].sort((a, b) => b.timeMs - a.timeMs);

    candidates.forEach((candidate, index) => {
        const expired = maxArchiveAgeDays !== undefined && now - candidate.timeMs > maxArchiveAgeDays * DAY_MS;
        const overCount = maxArchives !== undefined && index >= maxArchives;

        if (candidate.folder) {
            if (expired || overCount) {
                plan.drop.push(candidate.folder);
            } else {
                plan.pack.push({ folder: candidate.folder, archive: candidate.path, timeMs: candidate.timeMs });
            }
        } else if (expired || overCount) {
            plan.deleteArchives.push(candidate.path);
        }
    });

    return plan;
}

export interface FolderRetentionReport {
    plan: FolderRetentionPlan;
    packed: Array<{ folder: string; archive: string; archiveBytes: number; tarBytes: number; entries: number }>;
    failed: Array<{ folder: string; reason: string }>;
    skippedLowDisk: string[];
}

export interface ApplyRetentionOptions {
    /** Who runs it, for the ledger (`codex-migrate-home`, `app-retired`, …). */
    caller: string;
    /** Default: `tree`. */
    preset?: CompressPreset;
    /** Packing is skipped below this much free space (default 2 GiB): an archive needs room before the folder goes. */
    minFreeBytes?: number;
    /** How a folder, archive or temp leaves; default {@link removePath}. A caller may move them aside instead. */
    retire?: (path: string) => void;
}

/**
 * Carries out a plan from {@link planFolderRetention}: each older folder is packed into `<folder>.tar.zst`, the archive
 * is checked against the folder (every entry, size and file sha256), and only then is the folder retired. A failed
 * check removes the new archive and keeps the folder.
 */
export async function applyFolderRetention(
    plan: FolderRetentionPlan,
    options: ApplyRetentionOptions
): Promise<FolderRetentionReport> {
    const retire = options.retire ?? removePath;
    const preset = options.preset ?? PRESETS.tree;
    const minFree = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    const report: FolderRetentionReport = { plan, packed: [], failed: [], skippedLowDisk: [] };

    for (const temp of plan.staleTemps) {
        retire(temp);
    }

    for (const item of plan.pack) {
        if (freeBytes(plan.root) < minFree) {
            logger.warn({ folder: item.folder, minFree }, "[compress] too little free space to pack; folder kept");
            report.skippedLowDisk.push(item.folder);
            continue;
        }

        const startedAt = new Date().toISOString();

        try {
            const packed = await packDirectory({
                source: item.folder,
                archive: item.archive,
                level: preset.level,
                long: preset.long,
                frameBytes: preset.frameBytes,
                threads: preset.threads,
            });
            const seconds = item.timeMs / 1000;
            utimesSync(item.archive, seconds, seconds);
            const check = verifyArchiveAgainstFolder({ archive: item.archive, source: item.folder });

            if (!check.ok) {
                retire(item.archive);
                const reason = `archive check failed: ${check.missing.length} missing, ${check.mismatched.length} different`;
                logger.warn(
                    {
                        folder: item.folder,
                        missing: check.missing.slice(0, 5),
                        mismatched: check.mismatched.slice(0, 5),
                    },
                    `[compress] ${reason}`
                );
                report.failed.push({ folder: item.folder, reason });
                continue;
            }

            retire(item.folder);
            recordCompression({
                op: "pack",
                caller: options.caller,
                source: item.folder,
                target: item.archive,
                sourceBytes: packed.tarBytes,
                targetBytes: packed.compressedBytes,
                ratio: packed.tarBytes / Math.max(packed.compressedBytes, 1),
                preset: preset.name,
                level: preset.level,
                long: preset.long,
                frameBytes: preset.frameBytes,
                threads: preset.threads,
                removedOriginal: true,
                startedAt,
                endedAt: new Date().toISOString(),
            });
            logger.info(
                {
                    folder: item.folder,
                    archive: item.archive,
                    tarBytes: packed.tarBytes,
                    archiveBytes: packed.compressedBytes,
                    entries: check.entries,
                },
                "[compress] packed a folder"
            );
            report.packed.push({
                folder: item.folder,
                archive: item.archive,
                archiveBytes: packed.compressedBytes,
                tarBytes: packed.tarBytes,
                entries: check.entries,
            });
        } catch (err) {
            logger.warn({ err, folder: item.folder }, "[compress] packing a folder failed; folder kept");
            report.failed.push({ folder: item.folder, reason: err instanceof Error ? err.message : String(err) });
        }
    }

    for (const folder of plan.drop) {
        retire(folder);
        logger.info({ folder }, "[compress] removed a folder past the archive limits");
    }

    for (const archive of plan.deleteArchives) {
        retire(archive);
        logger.info({ archive }, "[compress] removed an archive past the archive limits");
    }

    return report;
}

// ── day-stamped files: compress in place once their day is over ──────────────────────────────────────────────────

export interface OldFileOptions {
    root: string;
    /**
     * The local or UTC day (`YYYY-MM-DD`) a file belongs to, from its path relative to `root` (`/`-separated), or
     * `undefined` when the file does not take part.
     */
    dayOf: (relativePath: string) => string | undefined;
    /** Files of this day or later stay plain (`YYYY-MM-DD`). */
    firstPlainDay: string;
    /** Files modified within this window stay plain too: a late writer may still append. Default 2 hours. */
    quietMs?: number;
    /** Walk sub-folders (`transcripts/<day>/<session>.jsonl`). */
    recursive?: boolean;
    now?: Date;
}

export interface OldFilePlan {
    root: string;
    compress: Array<{ path: string; bytes: number }>;
    /** Plain files whose `.zst` already exists (an earlier run stopped before removing the plain file). */
    finish: string[];
    staleTemps: string[];
}

function walkFiles(root: string, recursive: boolean, prefix = ""): Array<{ path: string; relative: string }> {
    const files: Array<{ path: string; relative: string }> = [];

    for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;

        if (dirent.isDirectory() && recursive) {
            files.push(...walkFiles(root, recursive, relative));
        } else if (dirent.isFile()) {
            files.push({ path: join(root, relative), relative });
        }
    }

    return files;
}

/** Which day-stamped files a compression pass would compress. Reads only: this is the dry run. */
export function planOldFileCompression(options: OldFileOptions): OldFilePlan {
    const { root, dayOf, firstPlainDay, recursive = false } = options;
    const quietMs = options.quietMs ?? 2 * 3_600_000;
    const now = (options.now ?? new Date()).getTime();
    const plan: OldFilePlan = { root, compress: [], finish: [], staleTemps: [] };

    if (!existsSync(root)) {
        return plan;
    }

    const files = walkFiles(root, recursive);
    const names = new Set(files.map((file) => file.path));

    for (const file of files) {
        if (file.relative.endsWith(".tmp")) {
            if (now - lstatSync(file.path).mtimeMs > STALE_TEMP_MS) {
                plan.staleTemps.push(file.path);
            }

            continue;
        }

        if (file.relative.endsWith(ZSTD_SUFFIX)) {
            continue;
        }

        const day = dayOf(file.relative);

        if (!day || day >= firstPlainDay) {
            continue;
        }

        const stat = lstatSync(file.path);

        if (now - stat.mtimeMs < quietMs) {
            continue;
        }

        if (names.has(`${file.path}${ZSTD_SUFFIX}`)) {
            plan.finish.push(file.path);
        } else {
            plan.compress.push({ path: file.path, bytes: stat.size });
        }
    }

    return plan;
}

export interface OldFileReport {
    plan: OldFilePlan;
    compressed: Array<{ path: string; bytes: number; compressedBytes: number }>;
    failed: Array<{ path: string; reason: string }>;
}

/** True when an existing `.zst` holds exactly the plain file's bytes; a `.zst` that does not decode is not the same. */
function sameContent(target: string, plain: { bytes: number; path: string }): boolean {
    try {
        const existing = digestZstdContent(target);
        return existing.bytes === plain.bytes && existing.sha256 === sha256File(plain.path);
    } catch (err) {
        logger.warn({ err, target }, "[compress] an existing .zst did not decode; compressing the plain file again");
        return false;
    }
}

/**
 * Carries out a plan from {@link planOldFileCompression}: each file becomes `<file>.zst` (seekable frames, its mode and
 * mtime kept), the result is decompressed and compared by size and sha256, the source is re-checked for a late write,
 * and only then is the plain file retired. Anything that does not check out keeps the plain file and drops the `.zst`.
 */
export async function applyOldFileCompression(
    plan: OldFilePlan,
    options: { caller: string; preset?: CompressPreset; retire?: (path: string) => void }
): Promise<OldFileReport> {
    const retire = options.retire ?? removePath;
    const preset = options.preset ?? PRESETS.text;
    const report: OldFileReport = { plan, compressed: [], failed: [] };

    for (const temp of plan.staleTemps) {
        retire(temp);
    }

    for (const path of plan.finish) {
        const target = `${path}${ZSTD_SUFFIX}`;
        const stat = lstatSync(path);

        if (sameContent(target, { bytes: stat.size, path })) {
            retire(path);
            report.compressed.push({ path, bytes: stat.size, compressedBytes: lstatSync(target).size });
        } else {
            plan.compress.push({ path, bytes: stat.size });
        }
    }

    for (const { path } of plan.compress) {
        const target = `${path}${ZSTD_SUFFIX}`;

        const startedAt = new Date().toISOString();

        try {
            const result = await compressFile({
                source: path,
                target,
                level: preset.level,
                long: preset.long,
                frameBytes: preset.frameBytes,
                threads: preset.threads,
                lineAligned: preset.lineAligned,
            });
            const seconds = result.sourceStat.mtimeMs / 1000;
            utimesSync(target, seconds, seconds);

            if (!verifyCompressedFile(target, result)) {
                unlinkSync(target);
                report.failed.push({ path, reason: "the compressed copy did not decode to the same bytes" });
                continue;
            }

            if (!sourceUnchanged(path, result.sourceStat)) {
                unlinkSync(target);
                report.failed.push({ path, reason: "the file changed while it was compressed" });
                continue;
            }

            retire(path);
            recordCompression({
                op: "compress",
                caller: options.caller,
                source: path,
                target,
                sourceBytes: result.bytes,
                targetBytes: result.compressedBytes,
                ratio: result.bytes / Math.max(result.compressedBytes, 1),
                preset: preset.name,
                level: preset.level,
                long: preset.long,
                frameBytes: preset.frameBytes,
                threads: preset.threads,
                inputSha256: result.sha256,
                removedOriginal: true,
                startedAt,
                endedAt: new Date().toISOString(),
            });
            report.compressed.push({ path, bytes: result.bytes, compressedBytes: result.compressedBytes });
        } catch (err) {
            logger.warn({ err, path }, "[compress] compressing an old file failed; plain file kept");
            report.failed.push({ path, reason: err instanceof Error ? err.message : String(err) });
        }
    }

    if (report.compressed.length > 0 || report.failed.length > 0) {
        logger.info(
            {
                root: plan.root,
                compressed: report.compressed.length,
                bytes: report.compressed.reduce((sum, item) => sum + item.bytes, 0),
                compressedBytes: report.compressed.reduce((sum, item) => sum + item.compressedBytes, 0),
                failed: report.failed.length,
            },
            "[compress] compressed old day files"
        );
    }

    return report;
}
