import { existsSync, lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { sha256File } from "@genesiscz/utils/fs/hash";
import {
    compressFile,
    decompressFile,
    digestZstdContent,
    readExistingAncestorSync,
    sourceUnchanged,
    verifyCompressedFile,
} from "./file";
import { type LedgerRecord, recordCompression, searchLedger } from "./ledger";
import {
    type CompressPreset,
    DEFAULT_MIN_SAVING,
    MEASURED_MEDIA_NOTE,
    MIN_USEFUL_SAVING,
    resolvePreset,
    trialSaving,
} from "./presets";
import { removePath } from "./retention";
import {
    archiveBaseName,
    assertArchiveOutsideSource,
    FOLDER_ARCHIVE_SUFFIX,
    isTarArchive,
    listArchive,
    packDirectory,
    type TarEntry,
    unpackArchive,
    verifyArchiveAgainstFolder,
} from "./tar";
import { ZSTD_SUFFIX, zstdContentBytes } from "./zstd";

/** Room kept free on top of the expected output, so a compression never fills the disk to the last byte. */
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;

export class CompressRefusal extends Error {}

function freeBytes(path: string): number {
    const { value: stats } = readExistingAncestorSync(path, statfsSync);
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
    /** Refuse when a trial saves less than this share (default {@link DEFAULT_MIN_SAVING}, 0.30). */
    minSaving?: number;
    /** Remove the original after the output is verified. Off by default: the original is kept. */
    removeOriginal?: boolean;
    /** Compress even when the trial saves too little or the preset stores. */
    force?: boolean;
    caller: string;
}

export interface CompressPathResult {
    record: LedgerRecord;
    warning?: string;
}

export interface CompressPathPlan {
    source: string;
    target: string;
    isFolder: boolean;
    preset: CompressPreset;
    level: number;
    inputBytes: number;
    /** Share a level-3 trial on a sample saved; NaN when there was nothing to sample. */
    trialSaving: number;
    /** Expected output size from the trial. */
    estimatedBytes: number;
    /** Why the run would not compress (too little saving, an existing output); undefined when it would. */
    refusal?: string;
    reason: string;
}

/** The first `bytes` of a folder's tar stream: the sample a folder's trial compresses. */
export async function sampleFolder(path: string, bytes = 32 * 1024 * 1024): Promise<Uint8Array> {
    const proc = Bun.spawn(["tar", "--no-xattrs", "-cf", "-", "-C", dirname(path), basename(path)], {
        stdout: "pipe",
        stderr: "ignore",
        env: { ...env.getProcessEnv(), COPYFILE_DISABLE: "1" },
    });
    const chunks: Uint8Array[] = [];
    let total = 0;

    for await (const chunk of proc.stdout) {
        chunks.push(chunk);
        total += chunk.length;

        if (total >= bytes) {
            proc.kill();
            break;
        }
    }

    await proc.exited;
    return Buffer.concat(chunks).subarray(0, bytes);
}

/**
 * What {@link compressPath} would do, from a trial on a sample (1 MiB of a file, the first 32 MiB of a folder's tar
 * stream). Writes nothing: this is the dry run, and the numbers `tools compress pack --dry-run` prints.
 */
export async function planCompressPath(
    options: Omit<CompressPathOptions, "caller" | "removeOriginal">
): Promise<CompressPathPlan> {
    const source = resolve(options.source);

    if (!existsSync(source)) {
        throw new CompressRefusal(`${source} does not exist`);
    }

    const isFolder = statSync(source).isDirectory();
    const choice = resolvePreset(source);
    const preset = options.preset ?? choice.preset;
    const level = options.level ?? preset.level;
    const target = options.target ?? `${source}${isFolder ? FOLDER_ARCHIVE_SUFFIX : ZSTD_SUFFIX}`;

    if (isFolder) {
        assertArchiveOutsideSource(source, target);
    }

    const inputBytes = isFolder ? folderBytes(source) : statSync(source).size;
    const saving = isFolder ? trialSaving(await sampleFolder(source), { level: 3 }) : choice.trialSaving;
    const minSaving = options.minSaving ?? DEFAULT_MIN_SAVING;
    const plan: CompressPathPlan = {
        source,
        target,
        isFolder,
        preset,
        level,
        inputBytes,
        trialSaving: saving,
        estimatedBytes: Math.round(inputBytes * (Number.isFinite(saving) ? 1 - saving : 1)),
        reason: isFolder
            ? choice.sniffed.reason
            : `${choice.sniffed.reason}, ${choice.sniffed.entropy.toFixed(2)} bits/byte`,
    };

    if (existsSync(target)) {
        plan.refusal = `${target} already exists; move it away or pass another --output`;
    } else if (!options.force && Number.isFinite(saving) && saving < minSaving) {
        plan.refusal = `a level-3 trial saved ${(saving * 100).toFixed(1)}%, under the ${(minSaving * 100).toFixed(0)}% minimum (${choice.sniffed.reason}); ${MEASURED_MEDIA_NOTE}. Pass --force or a lower --min-saving to compress anyway`;
    } else if (!options.force && preset.store) {
        plan.refusal = `the ${preset.name} preset stores data as it is (${MEASURED_MEDIA_NOTE}); pass --force to compress anyway`;
    }

    return plan;
}

/**
 * Compresses one file to `<file>.zst` or packs one folder to `<folder>.zst`, safely: room is checked first, the output
 * goes through a temp file, it is verified (decompressed and hashed for a file; every entry, size and sha256 for a
 * folder) before anything else happens, and the original is removed only with `removeOriginal` and only when it did
 * not change meanwhile. Every run lands in the ledger.
 */
export async function compressPath(options: CompressPathOptions): Promise<CompressPathResult> {
    const source = resolve(options.source);
    const { caller } = options;

    if (!existsSync(source)) {
        throw new CompressRefusal(`${source} does not exist`);
    }

    const plan = await planCompressPath(options);

    if (plan.refusal) {
        throw new CompressRefusal(`${source}: ${plan.refusal}`);
    }

    const { isFolder, preset, level, target, inputBytes, trialSaving: saving } = plan;
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
            : undefined;
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

    // File restores use the seek table for their space estimate. Folder restores also list destinations before
    // extraction: an archive filename alone cannot tell us which paths tar will write.
    const knownBytes = zstdContentBytes(archive);

    if (isTar) {
        const entries = listArchive(archive);
        const insideTarget = (path: string): boolean => {
            const parts = path.split(/[/\\]/);
            return parts[0] === name && parts.every((part) => part !== "" && part !== "." && part !== "..");
        };
        const root = entries.find((entry) => entry.path === name);

        if (
            root?.type !== "directory" ||
            entries.some(
                (entry) =>
                    !insideTarget(entry.path) ||
                    (entry.path === name && entry.type !== "directory") ||
                    (entry.type === "hardlink" && !insideTarget(entry.linkTarget ?? ""))
            )
        ) {
            throw new CompressRefusal(`${archive} must contain only the top folder ${name}; nothing extracted`);
        }

        restoredBytes = knownBytes ?? entries.reduce((sum, entry) => sum + entry.size, 0);
        assertRoomFor({ outputDir: into, inputBytes: restoredBytes, keptShare: 1 });
        await unpackArchive({ archive, destination: into });

        if (!existsSync(target)) {
            throw new Error(`${archive} did not restore ${target}: its top folder has another name`);
        }
    } else {
        assertRoomFor({ outputDir: into, inputBytes: knownBytes ?? digestZstdContent(archive).bytes, keptShare: 1 });
        const written = await decompressFile({ source: archive, target });
        restoredBytes = written.bytes;
        // The ledger knows the original's sha256 when this tool wrote the archive.
        const original = searchLedger({ path: archive }).find(
            (record) => record.target === archive && record.inputSha256
        );

        if (original?.inputSha256 && original.inputSha256 !== written.sha256) {
            removePath(target);
            throw new Error(
                `${archive} decompressed to other bytes than the original the ledger recorded; output removed`
            );
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
