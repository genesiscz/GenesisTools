import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileStreamed, isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { PRESETS } from "./presets";
import { readZstdFramesSync, SeekableZstdWriter, ZSTD_SUFFIX, type ZstdParams } from "./zstd";

/** Retry a filesystem read at the nearest existing ancestor, propagating every error except ENOENT. */
export function readExistingAncestorSync<T>(
    path: string,
    read: (ancestor: string) => T
): { ancestor: string; value: T } {
    let ancestor = resolve(path);

    for (;;) {
        try {
            return { ancestor, value: read(ancestor) };
        } catch (error) {
            const parent = dirname(ancestor);

            if (!isMissingFileError(error) || parent === ancestor) {
                throw error;
            }

            ancestor = parent;
        }
    }
}

const READ_CHUNK_BYTES = 1024 * 1024;

export interface ContentDigest {
    bytes: number;
    sha256: string;
}

/**
 * The file a read began on, as its handle saw it. Another file renamed over the name has another inode (or device),
 * even with the same length and a copied mtime, and any write or metadata change moves the ctime.
 */
export interface SourceStat {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}

/** True when `now` is still the file of `before`, with no write or metadata change since. */
export function sameSource(now: SourceStat, before: SourceStat): boolean {
    return (
        now.dev === before.dev &&
        now.ino === before.ino &&
        now.size === before.size &&
        now.mtimeMs === before.mtimeMs &&
        now.ctimeMs === before.ctimeMs
    );
}

export interface CompressFileResult extends ContentDigest {
    source: string;
    target: string;
    compressedBytes: number;
    frames: number;
    /** The source when the read began: a caller that removes the source re-checks it first ({@link sameSource}). */
    sourceStat: SourceStat;
}

/** Level, long mode, frame size, threads and line alignment that a caller leaves out come from the `text` preset. */
export interface CompressFileOptions extends ZstdParams {
    source: string;
    /** Defaults to `<source>.zst`. */
    target?: string;
    frameBytes?: number;
    /** Frames compressed at once. */
    threads?: number;
    /** Frames start on a line (every file compressed here so far is text). */
    lineAligned?: boolean;
    /** File mode of the result; defaults to the source's, so a 0600 transcript stays 0600. */
    mode?: number;
}

/**
 * Compresses a file into the zstd seekable format next to it (or at `target`), through a temp file and a rename, and
 * returns the digest of what it read. The source is read in 1 MiB chunks and never held whole. A source whose size,
 * mtime or ctime changed during the read throws and writes nothing. The source is left in place: removing it is the
 * caller's decision, after {@link verifyCompressedFile} and a re-stat that finds the same file ({@link sameSource}).
 */
export async function compressFile(options: CompressFileOptions): Promise<CompressFileResult> {
    const {
        source,
        level = PRESETS.text.level,
        long = PRESETS.text.long,
        checksum,
        frameBytes = PRESETS.text.frameBytes,
        threads = PRESETS.text.threads,
        lineAligned = PRESETS.text.lineAligned,
    } = options;
    const target = options.target ?? `${source}${ZSTD_SUFFIX}`;
    const fd = openSync(source, "r");
    const sourceStat = fstatSync(fd);
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    let frames = 0;
    let compressedBytes = 0;

    try {
        await atomicWriteFileStreamed(
            target,
            async (write) => {
                const writer = new SeekableZstdWriter({
                    write,
                    level,
                    long,
                    checksum,
                    frameBytes,
                    threads,
                    lineAligned,
                });
                const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);

                for (;;) {
                    const read = readSync(fd, chunk, 0, chunk.length, bytes);

                    if (read === 0) {
                        break;
                    }

                    const view = chunk.subarray(0, read);
                    hasher.update(view);
                    await writer.push(view);
                    bytes += read;
                }

                // A source cut, extended or rewritten during the read gives a digest of bytes the file never held at
                // one moment; throwing here keeps that copy from replacing the target (a verified `.zst` included).
                const end = fstatSync(fd);

                if (bytes !== sourceStat.size || !sameSource(end, sourceStat)) {
                    throw new Error(
                        `${source} changed while it was compressed (read ${bytes} of ${sourceStat.size} bytes, now ${end.size}); nothing written`
                    );
                }

                const stats = await writer.finish();
                frames = stats.frames;
                compressedBytes = stats.outputBytes;
            },
            { mode: options.mode ?? sourceStat.mode & 0o777 }
        );
    } finally {
        closeSync(fd);
    }

    return {
        source,
        target,
        bytes,
        sha256: hasher.digest("hex"),
        compressedBytes,
        frames,
        sourceStat: {
            dev: sourceStat.dev,
            ino: sourceStat.ino,
            size: sourceStat.size,
            mtimeMs: sourceStat.mtimeMs,
            ctimeMs: sourceStat.ctimeMs,
        },
    };
}

/** Size and sha256 of a zstd file's decompressed content, one frame in memory at a time. */
export function digestZstdContent(path: string): ContentDigest {
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;

    for (const frame of readZstdFramesSync(path)) {
        hasher.update(frame);
        bytes += frame.length;
    }

    return { bytes, sha256: hasher.digest("hex") };
}

/** True when the zstd file decompresses to exactly the expected content. A decode error counts as false. */
export function verifyCompressedFile(path: string, expected: ContentDigest): boolean {
    try {
        const actual = digestZstdContent(path);
        return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
    } catch (err) {
        logger.warn({ err, path }, "[compress] a compressed file did not decode while being verified");
        return false;
    }
}

/**
 * True when `path` still names the file that was read, as it was then: nothing appended to it or rewrote it, and no
 * other file was renamed over the name (a same-length copy with the old mtime included).
 */
export function sourceUnchanged(path: string, before: SourceStat): boolean {
    try {
        return sameSource(statSync(path), before);
    } catch (err) {
        logger.debug({ err, path }, "[compress] the source vanished or became unreadable after it was compressed");
        return false;
    }
}

/** Writes the decompressed content of a zstd file to `target` through a temp file and a rename. */
export async function decompressFile({ source, target }: { source: string; target: string }): Promise<ContentDigest> {
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;

    await atomicWriteFileStreamed(
        target,
        (write) => {
            for (const frame of readZstdFramesSync(source)) {
                hasher.update(frame);
                write(frame);
                bytes += frame.length;
            }
        },
        { mode: statSync(source).mode & 0o777 }
    );

    return { bytes, sha256: hasher.digest("hex") };
}
