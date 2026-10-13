import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileStreamed } from "@genesiscz/utils/storage/atomic-file";
import { readZstdFramesSync, SeekableZstdWriter, ZSTD_SUFFIX, type ZstdParams } from "./zstd";

const READ_CHUNK_BYTES = 1024 * 1024;

export interface ContentDigest {
    bytes: number;
    sha256: string;
}

export interface CompressFileResult extends ContentDigest {
    source: string;
    target: string;
    compressedBytes: number;
    frames: number;
    /** The source's size and mtime when the read began: a caller that removes the source re-checks them first. */
    sourceStat: { size: number; mtimeMs: number };
}

export interface CompressFileOptions extends ZstdParams {
    source: string;
    /** Defaults to `<source>.zst`. */
    target?: string;
    frameBytes?: number;
    /** Frames compressed at once (default 1). */
    threads?: number;
    /** Frames start on a line (default true: every file compressed here so far is text). */
    lineAligned?: boolean;
    /** File mode of the result; defaults to the source's, so a 0600 transcript stays 0600. */
    mode?: number;
}

/**
 * Compresses a file into the zstd seekable format next to it (or at `target`), through a temp file and a rename, and
 * returns the digest of what it read. The source is read in 1 MiB chunks and never held whole. The source is left in
 * place: removing it is the caller's decision, after {@link verifyCompressedFile} and a re-stat.
 */
export async function compressFile(options: CompressFileOptions): Promise<CompressFileResult> {
    const { source, level, long, checksum, frameBytes, threads, lineAligned = true } = options;
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
        sourceStat: { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs },
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

/** True when the file still has the size and mtime it had when it was read: nothing appended or rewrote it since. */
export function sourceUnchanged(path: string, before: { size: number; mtimeMs: number }): boolean {
    try {
        const now = statSync(path);
        return now.size === before.size && now.mtimeMs === before.mtimeMs;
    } catch (err) {
        logger.debug({ err, path }, "[compress] the source vanished or became unreadable after it was compressed");
        return false;
    }
}

/** Writes the decompressed content of a zstd file to `target` through a temp file and a rename. */
export async function decompressFile({ source, target }: { source: string; target: string }): Promise<ContentDigest> {
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;

    await atomicWriteFileStreamed(target, (write) => {
        for (const frame of readZstdFramesSync(source)) {
            hasher.update(frame);
            write(frame);
            bytes += frame.length;
        }
    });

    return { bytes, sha256: hasher.digest("hex") };
}
