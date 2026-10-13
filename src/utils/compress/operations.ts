import { existsSync, lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256File } from "@genesiscz/utils/fs/hash";
import { compressFile, decompressFile, digestZstdContent, sourceUnchanged, verifyCompressedFile } from "./file";
import { type LedgerRecord, recordCompression } from "./ledger";
import { type CompressPreset, MIN_USEFUL_SAVING, resolvePreset, sampleFile, trialSaving } from "./presets";
import { removePath } from "./retention";
import {
    archiveBaseName,
    FOLDER_ARCHIVE_SUFFIX,
    isTarArchive,
    listArchive,
    packDirectory,
    type TarEntry,
    unpackArchive,
    verifyArchiveAgainstFolder,
} from "./tar";
import { ZSTD_SUFFIX } from "./zstd";

/** Room kept free on top of the expected output, so a compression never fills the disk to the last byte. */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

export class CompressRefusal extends Error {}

function freeBytes(path: string): number {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
}

function folderBytes(path: string): number {
    let total = 0;
    const stack = [path];

    while (stack.length > 0) {
        const current = stack.pop()!;
        const stat = lstatSync(current);

        if (stat.isDirectory()) {
            for (const name of readdirSync(current)) {
                stack.push(join(current, name));
            }
        } else {
            total += stat.size;
        }
    }

    return total;
}

/**
 * Refuses when the output may not fit: the original stays on disk until the output is verified, so the output needs
 * room of its own. The estimate is the input size times the share a trial kept (the whole input when unknown).
 */
export function assertRoomFor({
    outputDir,
    inputBytes,
    keptShare,
}: {
    outputDir: string;
    inputBytes: number;
    keptShare: number;
}): void {
    const needed = Math.ceil(inputBytes * Math.min(1, Math.max(keptShare, 0.05))) + FREE_SPACE_MARGIN;
    const free = freeBytes(outputDir);

    if (free < needed) {
        throw new CompressRefusal(
            `not enough free space in ${outputDir}: about ${(needed / 1e9).toFixed(2)} GB needed while the original still exists, ${(free / 1e9).toFixed(2)} GB free`
        );
    }
}

export interface CompressPathOptions {
    source: string;
    /** Default: `<file>.zst` for a file, `<folder>.zst` for a folder. */
    target?: string;
    /** Default: resolved from the data ({@link resolvePreset}). */
    preset?: CompressPreset;
    /** Overrides the preset's level. */
    level?: number;
    /** Remove the original after the output is verified. Off by default: the original is kept. */
    removeOriginal?: boolean;
    /** Compress even when the preset says the data is already compressed. */
    force?: boolean;
    caller: string;
}

export interface CompressPathResult {
    record: LedgerRecord;
    warning?: string;
}

/**
 * Compresses one file to `<file>.zst` or packs one folder to `<folder>.zst`, safely: room is checked first, the output
 * goes through a temp file, it is verified (decompressed and hashed for a file; every entry, size and sha256 for a
 * folder) before anything else happens, and the original is removed only with `removeOriginal` and only when it did
 * not change meanwhile. Every run lands in the ledger.
 */
export async function compressPath(options: CompressPathOptions): Promise<CompressPathResult> {
    const { source, caller } = options;

    if (!existsSync(source)) {
        throw new CompressRefusal(`${source} does not exist`);
    }

    const isFolder = statSync(source).isDirectory();
    const choice = options.preset ? undefined : resolvePreset(source);
    const preset = options.preset ?? choice!.preset;
    const level = options.level ?? preset.level;
    const target = options.target ?? `${source}${isFolder ? FOLDER_ARCHIVE_SUFFIX : ZSTD_SUFFIX}`;

    if (preset.store && !options.force) {
        throw new CompressRefusal(
            `${source}: ${choice?.warning ?? "the media preset stores data as it is"}; pass --force to compress anyway`
        );
    }

    if (existsSync(target)) {
        throw new CompressRefusal(`${target} already exists; move it away or pass another --output`);
    }

    const inputBytes = isFolder ? folderBytes(source) : statSync(source).size;
    const saving = choice?.trialSaving ?? (isFolder ? Number.NaN : trialSaving(sampleFile(source), { level: 3 }));
    assertRoomFor({ outputDir: dirname(target), inputBytes, keptShare: Number.isFinite(saving) ? 1 - saving : 1 });
    const startedAt = new Date().toISOString();
    const params = { level, long: preset.long, frameBytes: preset.frameBytes, threads: preset.threads };
    let record: LedgerRecord;

    if (isFolder) {
        const packed = await packDirectory({ source, archive: target, ...params });
        const check = verifyArchiveAgainstFolder({ archive: target, source });

        if (!check.ok) {
            removePath(target);
            throw new Error(
                `the archive did not match ${source} (${check.missing.length} missing, ${check.mismatched.length} different); archive removed, folder kept`
            );
        }

        if (options.removeOriginal) {
            removePath(source);
        }

        record = recordCompression({
            op: "pack",
            caller,
            source,
            target,
            sourceBytes: packed.tarBytes,
            targetBytes: packed.compressedBytes,
            ratio: packed.tarBytes / Math.max(packed.compressedBytes, 1),
            preset: preset.name,
            ...params,
            outputSha256: sha256File(target),
            removedOriginal: options.removeOriginal === true,
            startedAt,
            endedAt: new Date().toISOString(),
        });
    } else {
        const result = await compressFile({ source, target, lineAligned: preset.lineAligned, ...params });

        if (!verifyCompressedFile(target, result)) {
            removePath(target);
            throw new Error(`the compressed copy of ${source} did not decode to the same bytes; output removed`);
        }

        const removable = options.removeOriginal === true && sourceUnchanged(source, result.sourceStat);

        if (options.removeOriginal && !removable) {
            throw new CompressRefusal(`${source} changed while it was compressed; both files kept`);
        }

        if (removable) {
            removePath(source);
        }

        record = recordCompression({
            op: "compress",
            caller,
            source,
            target,
            sourceBytes: result.bytes,
            targetBytes: result.compressedBytes,
            ratio: result.bytes / Math.max(result.compressedBytes, 1),
            preset: preset.name,
            ...params,
            inputSha256: result.sha256,
            outputSha256: sha256File(target),
            removedOriginal: removable,
            startedAt,
            endedAt: new Date().toISOString(),
        });
    }

    const warning =
        Number.isFinite(saving) && saving < MIN_USEFUL_SAVING
            ? `saved only ${(saving * 100).toFixed(2)}% in the trial`
            : choice?.warning;
    return { record, warning };
}

export interface ExpandOptions {
    archive: string;
    /** Folder the result goes into; default: the archive's own folder. */
    into?: string;
    removeArchive?: boolean;
    caller: string;
}

/**
 * Restores a `.zst`: a packed folder (`x.zst` or `x.tar.zst` holding a tar stream) back to `x/`, a compressed file
 * back to `x`. Refuses to overwrite. The archive is removed only with `removeArchive`, after the restore finished.
 */
export async function expandPath(options: ExpandOptions): Promise<LedgerRecord> {
    const { archive, caller } = options;
    const into = options.into ?? dirname(archive);
    const name = archiveBaseName(basename(archive));
    const target = join(into, name);

    if (existsSync(target)) {
        throw new CompressRefusal(`${target} already exists; refusing to overwrite it`);
    }

    const archiveBytes = statSync(archive).size;
    const startedAt = new Date().toISOString();
    const isTar = isTarArchive(archive);
    let restoredBytes: number;
    let outputSha256: string | undefined;

    if (isTar) {
        restoredBytes = listArchive(archive).reduce((sum, entry) => sum + entry.size, 0);
        assertRoomFor({ outputDir: into, inputBytes: restoredBytes, keptShare: 1 });
        await unpackArchive({ archive, destination: into });

        if (!existsSync(target)) {
            throw new Error(`${archive} did not restore ${target}: its top folder has another name`);
        }
    } else {
        const digest = digestZstdContent(archive);
        restoredBytes = digest.bytes;
        assertRoomFor({ outputDir: into, inputBytes: restoredBytes, keptShare: 1 });
        const written = await decompressFile({ source: archive, target });

        if (written.sha256 !== digest.sha256) {
            removePath(target);
            throw new Error(`${archive} decompressed differently on the second read; output removed`);
        }

        outputSha256 = written.sha256;
    }

    if (options.removeArchive) {
        removePath(archive);
    }

    return recordCompression({
        op: isTar ? "unpack" : "decompress",
        caller,
        source: archive,
        target,
        sourceBytes: archiveBytes,
        targetBytes: restoredBytes,
        ratio: restoredBytes / Math.max(archiveBytes, 1),
        outputSha256,
        removedOriginal: options.removeArchive === true,
        startedAt,
        endedAt: new Date().toISOString(),
    });
}

export interface VerifyResult {
    ok: boolean;
    kind: "folder" | "file";
    bytes: number;
    entries?: TarEntry[];
    detail: string;
}

/**
 * Reads a `.zst` end to end (every frame's checksum is checked by the decoder) and, with `against`, compares it with
 * the original: a folder entry by entry with sha256, a file by size and sha256.
 */
export function verifyPath({ archive, against }: { archive: string; against?: string }): VerifyResult {
    if (isTarArchive(archive)) {
        if (against) {
            const check = verifyArchiveAgainstFolder({ archive, source: against });
            return {
                ok: check.ok,
                kind: "folder",
                bytes: 0,
                detail: check.ok
                    ? `${check.entries} entries match ${against}`
                    : `${check.missing.length} missing, ${check.mismatched.length} different, ${check.extra.length} extra`,
            };
        }

        const entries = listArchive(archive, { hash: true });
        const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        return { ok: true, kind: "folder", bytes, entries, detail: `${entries.length} entries read and hashed` };
    }

    const digest = digestZstdContent(archive);

    if (against) {
        const ok = statSync(against).size === digest.bytes && sha256File(against) === digest.sha256;
        return { ok, kind: "file", bytes: digest.bytes, detail: ok ? `matches ${against}` : `differs from ${against}` };
    }

    return {
        ok: true,
        kind: "file",
        bytes: digest.bytes,
        detail: `decoded ${digest.bytes} bytes, sha256 ${digest.sha256}`,
    };
}
