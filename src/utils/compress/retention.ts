import {
    closeSync,
    existsSync,
    fstatSync,
    ftruncateSync,
    lstatSync,
    openSync,
    readdirSync,
    rmSync,
    statfsSync,
    unlinkSync,
    utimesSync,
} from "node:fs";
import { join } from "node:path";
import { sha256File } from "@genesiscz/utils/fs/hash";
import type { FileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { logger } from "@genesiscz/utils/logger";
import { isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { assertTestSafePath } from "@genesiscz/utils/storage/real-home-guard";
import { compressFile, digestZstdContent, type SourceStat, sameSource, verifyCompressedFile } from "./file";
import { recordCompression } from "./ledger";
import { type CompressPreset, PRESETS } from "./presets";
import {
    archiveBaseName,
    changedSinceCheck,
    FOLDER_ARCHIVE_SUFFIX,
    packDirectory,
    verifyArchiveAgainstFolder,
} from "./tar";
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
    /**
     * With both archive limits set, an archive goes only when it is past BOTH (beyond `maxArchives` and older than
     * `maxArchiveAgeDays`), so the limit that keeps more wins. Unset: it goes past either limit.
     */
    keepYoungArchives?: boolean;
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

/** The archive limits a plan was made with, so {@link applyFolderRetention} can rank the archives again after packing. */
export interface ArchiveLimits {
    maxArchiveAgeDays?: number;
    maxArchives?: number;
    keepYoungArchives?: boolean;
    /** The plan's clock, in ms. */
    nowMs: number;
}

/** An archive the plan ranked: one already on disk, or the one a folder would be packed into. */
export interface RankedArchive {
    path: string;
    timeMs: number;
    /** Set when the archive does not exist yet: the folder it would be packed from (a planned pack or drop). */
    folder?: string;
}

export interface FolderRetentionPlan {
    root: string;
    kept: string[];
    pack: PlannedPack[];
    /** Folders already past the archive limits: removed without an archive. */
    drop: string[];
    deleteArchives: string[];
    staleTemps: string[];
    /**
     * Every archive the plan ranked, newest first, with the limits it used. A pack that is skipped or fails leaves no
     * archive, so {@link applyFolderRetention} ranks them again without it before it removes anything.
     */
    ranking: { archives: RankedArchive[]; limits: ArchiveLimits };
}

/**
 * For each archive (newest first), whether it is past the limits. Its rank is the number of newer entries that
 * `counts`: the plan counts every entry, {@link applyFolderRetention} only the archives that exist after packing.
 */
function pastArchiveLimits(
    archives: readonly RankedArchive[],
    limits: ArchiveLimits,
    counts: (archive: RankedArchive) => boolean = () => true
): boolean[] {
    const { maxArchiveAgeDays, maxArchives, nowMs } = limits;
    const unionKeep = limits.keepYoungArchives && maxArchiveAgeDays !== undefined && maxArchives !== undefined;
    let rank = 0;

    return archives.map((archive) => {
        const expired = maxArchiveAgeDays !== undefined && nowMs - archive.timeMs > maxArchiveAgeDays * DAY_MS;
        const overCount = maxArchives !== undefined && rank >= maxArchives;

        if (counts(archive)) {
            rank++;
        }

        return unionKeep ? expired && overCount : expired || overCount;
    });
}

/** What a retention run would do. Reads only: this is the dry run. */
export function planFolderRetention(options: FolderRetentionOptions): FolderRetentionPlan {
    const { root, keep, keepMaxAgeDays, maxArchiveAgeDays, maxArchives, keepYoungArchives } = options;
    const include = options.include ?? ((name: string) => !name.startsWith("."));
    const timeOf = options.timeOf ?? ((entry: { mtimeMs: number }) => entry.mtimeMs);
    const now = (options.now ?? new Date()).getTime();
    const limits: ArchiveLimits = { maxArchiveAgeDays, maxArchives, keepYoungArchives, nowMs: now };
    const plan: FolderRetentionPlan = {
        root,
        kept: [],
        pack: [],
        drop: [],
        deleteArchives: [],
        staleTemps: [],
        ranking: { archives: [], limits },
    };

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
    const candidates: RankedArchive[] = [
        ...archives.filter((archive) => !repacked.has(archive.path)),
        ...older.map((folder) => ({
            path: `${folder.path}${FOLDER_ARCHIVE_SUFFIX}`,
            timeMs: folder.timeMs,
            folder: folder.path,
        })),
    ].sort((a, b) => b.timeMs - a.timeMs);
    plan.ranking.archives = candidates;
    const pastLimits = pastArchiveLimits(candidates, limits);

    candidates.forEach((candidate, index) => {
        const past = pastLimits[index];

        if (candidate.folder) {
            if (past) {
                plan.drop.push(candidate.folder);
            } else {
                plan.pack.push({ folder: candidate.folder, archive: candidate.path, timeMs: candidate.timeMs });
            }
        } else if (past) {
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
    /** Planned drops and archive deletions that were carried out. */
    removed: string[];
    /** Planned drops and archive deletions kept, because a newer pack that outranked them left no archive. */
    spared: string[];
}

/**
 * The drops and archive deletions still past the limits when only the archives that exist after packing outrank them
 * (those already on disk and the packs that worked). A skipped or failed pack, or a folder kept by this check, is still
 * a folder, so it never pushes out an archive it was to replace. Keyed by folder for a drop and by path for an archive.
 */
function stillPastLimits(plan: FolderRetentionPlan, packed: ReadonlySet<string>): Set<string> {
    const { archives, limits } = plan.ranking;
    const past = pastArchiveLimits(archives, limits, (archive) => !archive.folder || packed.has(archive.folder));
    return new Set(archives.filter((_, index) => past[index]).map((archive) => archive.folder ?? archive.path));
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
 * check removes the new archive and keeps the folder. Drops and archive deletions run last, ranked again without the
 * packs that left no archive, so a skipped or failed pack never costs an older archive its place.
 */
export async function applyFolderRetention(
    plan: FolderRetentionPlan,
    options: ApplyRetentionOptions
): Promise<FolderRetentionReport> {
    const retire = options.retire ?? removePath;
    const preset = options.preset ?? PRESETS.tree;
    const minFree = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
    const report: FolderRetentionReport = { plan, packed: [], failed: [], skippedLowDisk: [], removed: [], spared: [] };

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
                const reason = `archive check failed: ${check.missing.length} missing, ${check.mismatched.length} different, ${check.extra.length} extra`;
                logger.warn(
                    {
                        folder: item.folder,
                        missing: check.missing.slice(0, 5),
                        mismatched: check.mismatched.slice(0, 5),
                        extra: check.extra.slice(0, 5),
                    },
                    `[compress] ${reason}`
                );
                report.failed.push({ folder: item.folder, reason });
                continue;
            }

            // A file written after its sha256 matched, or a new one in the folder, is not in the archive.
            const changed = changedSinceCheck(check);

            if (changed.length > 0) {
                retire(item.archive);
                const reason = `the folder changed while it was checked (${changed.length} entries)`;
                logger.warn({ folder: item.folder, changed: changed.slice(0, 5) }, `[compress] ${reason}`);
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
                inputSha256: packed.sha256,
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

    const stillPast = stillPastLimits(plan, new Set(report.packed.map((item) => item.folder)));

    for (const path of [...plan.drop, ...plan.deleteArchives]) {
        if (!stillPast.has(path)) {
            logger.info({ path }, "[compress] kept: a newer pack that would have replaced it left no archive");
            report.spared.push(path);
            continue;
        }

        retire(path);
        report.removed.push(path);
        logger.info({ path }, "[compress] removed past the archive limits");
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

/**
 * How long a retired file keeps its blocks after its name is gone, so a reader that opened it just before (an rg that
 * maps it, which a cut file would kill with SIGBUS) finishes first. New readers find the `.zst` from the start.
 */
const RELEASE_GRACE_MS = 10_000;

/** A plain file a verified `.zst` replaced, as it was just before it was retired. */
export interface ReplacedFile {
    plain: string;
    /** The plain file's identity before it was retired, for caches keyed by it (`carrySavedEntries`). */
    identity: FileIdentity;
    compressed: string;
}

/** What became of a plain file its verified `.zst` replaced, at the moment it was to be retired. */
type Retirement =
    /** Retired; `fd` (null when it could not be opened, or on Windows) frees its blocks in {@link releaseBlocks}. */
    | { status: "retired"; fd: number | null; identity: FileIdentity }
    /** A late write: the plain file stays and the `.zst` is dropped. */
    | { status: "changed" }
    /** Already gone (removed by hand or by another pass): the verified `.zst` is now its only copy and stays. */
    | { status: "gone" };

/**
 * Retires a plain file that its verified `.zst` replaced, when it is still the file that was compressed: the same
 * device and inode (no other file was renamed over the name, not even a same-length copy with the old mtime) and the
 * same size, mtime and ctime (no late write). The handle is opened before the name goes, because a process that still
 * has the file open keeps every block on disk after the unlink: on 2026-11-01 31 handles that launchers and idle
 * loggers held kept 1.2 GB of removed day logs.
 */
function retireReplaced(path: string, before: SourceStat, retire: (path: string) => void): Retirement {
    let fd: number | null = null;

    try {
        // Windows cannot remove an open file; there only the name goes.
        fd = process.platform === "win32" ? null : openSync(path, "r+");
    } catch (err) {
        if (isMissingFileError(err)) {
            return { status: "gone" };
        }

        logger.debug({ err, path }, "[compress] the plain file did not open for the release; it is only removed");
    }

    let now: SourceStat;

    try {
        now = fd === null ? lstatSync(path) : fstatSync(fd);
    } catch (err) {
        if (fd !== null) {
            closeSync(fd);
        }

        if (isMissingFileError(err)) {
            return { status: "gone" };
        }

        logger.debug({ err, path }, "[compress] the source became unreadable after it was compressed");
        return { status: "changed" };
    }

    if (!sameSource(now, before)) {
        if (fd !== null) {
            closeSync(fd);
        }

        return { status: "changed" };
    }

    try {
        retire(path);
    } catch (err) {
        if (fd !== null) {
            closeSync(fd);
        }

        throw err;
    }

    return {
        status: "retired",
        fd,
        identity: { ino: now.ino, size: now.size, mtimeMs: now.mtimeMs, ctimeMs: now.ctimeMs },
    };
}

/**
 * After the grace, cuts one retired file that no folder names any more (`nlink` 0) to zero bytes through its handle,
 * which frees its blocks even while another process still holds it open, and closes the handle. Each file runs on its
 * own timer from the moment it is retired, so a pass over a backlog frees every file while the later ones still
 * compress, instead of holding all of them until the end. A retire that only moved the file (a trash) leaves a name,
 * and that file is not touched. Resolves to the bytes freed; never rejects.
 */
async function releaseBlocks(fd: number, graceMs: number): Promise<number> {
    if (graceMs > 0) {
        await Bun.sleep(graceMs);
    }

    try {
        const stat = fstatSync(fd);

        if (stat.nlink === 0) {
            ftruncateSync(fd, 0);
            return stat.size;
        }
    } catch (err) {
        logger.debug({ err, fd }, "[compress] a retired file's blocks were not released");
    } finally {
        closeSync(fd);
    }

    return 0;
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
 * and only then is the plain file retired. Anything that does not check out keeps the plain file and drops the `.zst`;
 * a plain file that is already gone keeps its verified `.zst`, its only copy. Each removed file is then cut to zero
 * bytes `releaseGraceMs` after its own removal, so a process that still holds it open (an idle logger, a launcher that
 * inherited the handle) no longer keeps its blocks on disk, and the pass frees them while it compresses the next file.
 * Run it under the daily pass's lock (`runDailyCompression`): two passes over one folder must not overlap.
 */
export async function applyOldFileCompression(
    plan: OldFilePlan,
    options: {
        caller: string;
        preset?: CompressPreset;
        retire?: (path: string) => void;
        /** How long a retired file keeps its blocks for a reader that opened it just before; default 10 s. */
        releaseGraceMs?: number;
        /** Called for each plain file once its `.zst` replaced it (a cache moves its entry over). */
        onReplaced?: (replaced: ReplacedFile) => void;
    }
): Promise<OldFileReport> {
    const retire = options.retire ?? removePath;
    const preset = options.preset ?? PRESETS.text;
    const graceMs = options.releaseGraceMs ?? RELEASE_GRACE_MS;
    const report: OldFileReport = { plan, compressed: [], failed: [] };
    const releases: Array<Promise<number>> = [];
    const replaced = (plain: string, retired: { fd: number | null; identity: FileIdentity }) => {
        if (retired.fd !== null) {
            releases.push(releaseBlocks(retired.fd, graceMs));
        }

        try {
            options.onReplaced?.({ plain, identity: retired.identity, compressed: `${plain}${ZSTD_SUFFIX}` });
        } catch (err) {
            logger.debug({ err, plain }, "[compress] the replaced-file hook failed; the file is compressed anyway");
        }
    };
    const keptOnlyCopy = (path: string) =>
        logger.info({ path }, "[compress] the plain file was already gone; its verified .zst is kept as the only copy");
    let releasedBytes = 0;

    try {
        for (const temp of plan.staleTemps) {
            retire(temp);
        }

        for (const path of plan.finish) {
            const target = `${path}${ZSTD_SUFFIX}`;
            let stat: SourceStat;

            try {
                stat = lstatSync(path);
            } catch (err) {
                if (isMissingFileError(err)) {
                    keptOnlyCopy(path);
                    continue;
                }

                throw err;
            }

            const retired: Retirement = sameContent(target, { bytes: stat.size, path })
                ? retireReplaced(path, stat, retire)
                : { status: "changed" };

            if (retired.status === "changed") {
                plan.compress.push({ path, bytes: stat.size });
                continue;
            }

            if (retired.status === "retired") {
                replaced(path, retired);
            } else {
                keptOnlyCopy(path);
            }

            report.compressed.push({ path, bytes: stat.size, compressedBytes: lstatSync(target).size });
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

                const retired = retireReplaced(path, result.sourceStat, retire);

                if (retired.status === "changed") {
                    unlinkSync(target);
                    report.failed.push({ path, reason: "the file changed while it was compressed" });
                    continue;
                }

                if (retired.status === "retired") {
                    replaced(path, retired);
                } else {
                    keptOnlyCopy(path);
                }

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
                    removedOriginal: retired.status === "retired",
                    startedAt,
                    endedAt: new Date().toISOString(),
                });
                report.compressed.push({ path, bytes: result.bytes, compressedBytes: result.compressedBytes });
            } catch (err) {
                logger.warn({ err, path }, "[compress] compressing an old file failed; plain file kept");
                report.failed.push({ path, reason: err instanceof Error ? err.message : String(err) });
            }
        }
    } finally {
        releasedBytes = (await Promise.all(releases)).reduce((sum, bytes) => sum + bytes, 0);
    }

    if (report.compressed.length > 0 || report.failed.length > 0) {
        logger.info(
            {
                root: plan.root,
                compressed: report.compressed.length,
                bytes: report.compressed.reduce((sum, item) => sum + item.bytes, 0),
                compressedBytes: report.compressed.reduce((sum, item) => sum + item.compressedBytes, 0),
                releasedBytes,
                failed: report.failed.length,
            },
            "[compress] compressed old day files"
        );
    }

    return report;
}
