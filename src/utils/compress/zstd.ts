import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { constants as zlibConstants, zstdCompress, zstdCompressSync } from "node:zlib";

/**
 * zstd for files that are written once and read later: seekable frames, a seek table, and frame-by-frame reads.
 *
 * Why the frames are walked here and not by a stream: on Bun 1.3.13 (still supported) `node:zlib` zstd, both
 * `zstdDecompressSync` and `createZstdDecompress`, stops after the FIRST frame of a multi-frame file and returns a
 * silently short result (7,000 of 14,000 bytes in a probe on 2026-10-13); Bun 1.4.2 reads every frame.
 * `Bun.zstdDecompressSync` reads every frame on both. So every reader here splits the file into frames itself and
 * decompresses one frame at a time, which also bounds memory to one frame.
 *
 * The files follow the zstd seekable format (contrib/seekable_format in the zstd repository): independent frames of
 * at most `frameBytes` input bytes each, then one skippable frame holding the seek table. Every zstd decoder skips
 * that frame, so `zstd -d`, `zstdcat` and `rg -z` read these files as plain zstd.
 */

export const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f;
const SEEK_TABLE_MAGIC = 0x184d2a5e;
const SEEKABLE_FOOTER_MAGIC = 0x8f92eab1;
const SEEK_FOOTER_BYTES = 9;

/** Input bytes per frame. A tail read decompresses about one frame; 4 MiB keeps that near 5 ms. */
export const DEFAULT_FRAME_BYTES = 4 * 1024 * 1024;
/** zstd level for files written by this module. Level 3 is zstd's own default: ~300 MB/s in, ~1 GB/s out. */
export const DEFAULT_ZSTD_LEVEL = 3;
/** The file name suffix every compressed file here carries. */
export const ZSTD_SUFFIX = ".zst";

export interface ZstdFrame {
    /** Byte offset of the frame in the file. */
    offset: number;
    compressedSize: number;
    /** Known from the seek table, or from the frame header when the encoder wrote it. */
    decompressedSize?: number;
}

/** True when the path names a zstd file by its suffix: the rule every reader here routes on. */
export function isZstdPath(path: string): boolean {
    return path.endsWith(ZSTD_SUFFIX);
}

export function compressBytes(data: Uint8Array | string, level = DEFAULT_ZSTD_LEVEL): Uint8Array {
    return Bun.zstdCompressSync(typeof data === "string" ? Buffer.from(data) : data, { level });
}

/** Decompresses every frame of `data` (`Bun.zstdDecompressSync` handles several frames on Bun 1.3.13 too). */
export function decompressBytes(data: Uint8Array): Uint8Array {
    return Bun.zstdDecompressSync(data);
}

function readExactly(fd: number, length: number, position: number): Buffer {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;

    while (read < length) {
        const got = readSync(fd, buffer, read, length - read, position + read);

        if (got === 0) {
            throw new Error(`zstd: unexpected end of file at byte ${position + read} (wanted ${length} bytes)`);
        }

        read += got;
    }

    return buffer;
}

/**
 * The frames listed in a seek table at the end of the file, or `null` when the file has none (or one that does not
 * add up to the frames before it, which is then not trusted).
 */
export function readSeekTable(fd: number, size: number): ZstdFrame[] | null {
    if (size < SEEK_FOOTER_BYTES + 8) {
        return null;
    }

    const footer = readExactly(fd, SEEK_FOOTER_BYTES, size - SEEK_FOOTER_BYTES);

    if (footer.readUInt32LE(5) !== SEEKABLE_FOOTER_MAGIC) {
        return null;
    }

    const count = footer.readUInt32LE(0);
    const entryBytes = (footer[4] ?? 0) & 0x80 ? 12 : 8;
    const tableBytes = count * entryBytes + SEEK_FOOTER_BYTES;
    const skippableStart = size - tableBytes - 8;

    if (skippableStart < 0) {
        return null;
    }

    const table = readExactly(fd, tableBytes + 8, skippableStart);

    if (table.readUInt32LE(0) !== SEEK_TABLE_MAGIC || table.readUInt32LE(4) !== tableBytes) {
        return null;
    }

    const frames: ZstdFrame[] = [];
    let offset = 0;

    for (let index = 0; index < count; index++) {
        const at = 8 + index * entryBytes;
        const compressedSize = table.readUInt32LE(at);
        frames.push({ offset, compressedSize, decompressedSize: table.readUInt32LE(at + 4) });
        offset += compressedSize;
    }

    // The frames must fill the file up to the table exactly; anything else is not a table this reader can trust.
    return offset === skippableStart ? frames : null;
}

/** Frame content size from a frame header, when the encoder wrote one. */
function headerContentSize(header: Buffer, descriptor: number): { headerBytes: number; contentSize?: number } {
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const didBytes = [0, 1, 2, 4][descriptor & 3] ?? 0;
    const fcsBytes = fcsFlag === 0 ? singleSegment : ([0, 2, 4, 8][fcsFlag] ?? 0);
    const fcsAt = 1 + (singleSegment ? 0 : 1) + didBytes;
    const headerBytes = fcsAt + fcsBytes;
    let contentSize: number | undefined;

    if (fcsBytes === 1) {
        contentSize = header[fcsAt];
    } else if (fcsBytes === 2) {
        contentSize = header.readUInt16LE(fcsAt) + 256;
    } else if (fcsBytes === 4) {
        contentSize = header.readUInt32LE(fcsAt);
    } else if (fcsBytes === 8) {
        contentSize = Number(header.readBigUInt64LE(fcsAt));
    }

    return { headerBytes, contentSize };
}

/**
 * The frames of any zstd file, found by reading frame and block headers (3 bytes per block of at most 128 KB), so
 * nothing is decompressed. Skippable frames are left out. Used when the file has no seek table: a file written by
 * the `zstd` CLI is one frame, a concatenation of files is several.
 */
export function walkFrames(fd: number, size: number): ZstdFrame[] {
    const frames: ZstdFrame[] = [];
    let offset = 0;

    while (offset < size) {
        const magic = readExactly(fd, 4, offset).readUInt32LE(0);

        if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
            offset += 8 + readExactly(fd, 4, offset + 4).readUInt32LE(0);
            continue;
        }

        if (magic !== ZSTD_FRAME_MAGIC) {
            throw new Error(`zstd: no frame at byte ${offset} (magic 0x${magic.toString(16)})`);
        }

        const header = readExactly(fd, Math.min(18, size - offset - 4), offset + 4);
        const descriptor = header[0] ?? 0;
        const { headerBytes, contentSize } = headerContentSize(header, descriptor);
        let position = offset + 4 + headerBytes;

        for (;;) {
            const block = readExactly(fd, 3, position);
            const value = block[0]! | (block[1]! << 8) | (block[2]! << 16);
            const last = value & 1;
            const type = (value >> 1) & 3;
            const blockSize = value >>> 3;

            if (type === 3) {
                throw new Error(`zstd: reserved block type at byte ${position}`);
            }

            position += 3 + (type === 1 ? 1 : blockSize);

            if (last) {
                break;
            }
        }

        if ((descriptor >> 2) & 1) {
            position += 4;
        }

        frames.push({ offset, compressedSize: position - offset, decompressedSize: contentSize });
        offset = position;
    }

    return frames;
}

/** The frames of an open zstd file: from its seek table when it has one, else by walking the headers. */
export function zstdFrames(fd: number, size: number): ZstdFrame[] {
    return readSeekTable(fd, size) ?? walkFrames(fd, size);
}

/** The decompressed size of a zstd file from its seek table or frame headers, without decompressing; undefined when a frame does not say. */
export function zstdContentBytes(path: string): number | undefined {
    const fd = openSync(path, "r");

    try {
        let total = 0;

        for (const frame of zstdFrames(fd, fstatSync(fd).size)) {
            if (frame.decompressedSize === undefined) {
                return undefined;
            }

            total += frame.decompressedSize;
        }

        return total;
    } finally {
        closeSync(fd);
    }
}

export function decompressFrame(fd: number, frame: ZstdFrame): Uint8Array {
    return Bun.zstdDecompressSync(readExactly(fd, frame.compressedSize, frame.offset));
}

/**
 * The decompressed content of a zstd file, one frame at a time, in file order (`fromEnd`: newest frame first).
 * Memory holds one frame: about `frameBytes` for files this module wrote, the whole content for a one-frame file
 * written by the `zstd` CLI.
 */
export function* readZstdFramesSync(
    path: string,
    { fromEnd = false }: { fromEnd?: boolean } = {}
): Generator<Uint8Array> {
    const fd = openSync(path, "r");

    try {
        const frames = zstdFrames(fd, fstatSync(fd).size);
        const ordered = fromEnd ? [...frames].reverse() : frames;

        for (const frame of ordered) {
            yield decompressFrame(fd, frame);
        }
    } finally {
        closeSync(fd);
    }
}

/**
 * {@link readZstdFramesSync} with up to `concurrency` frames decompressing at once on the thread pool, yielded in file
 * order: the next frames decompress while the caller works on the current one. Memory holds about `concurrency`
 * frames.
 */
export async function* readZstdFrames(
    path: string,
    { concurrency = 4, fromEnd = false }: { concurrency?: number; fromEnd?: boolean } = {}
): AsyncGenerator<Uint8Array> {
    const fd = openSync(path, "r");

    try {
        const frames = zstdFrames(fd, fstatSync(fd).size);
        const ordered = fromEnd ? [...frames].reverse() : frames;
        const window: Array<Promise<Uint8Array>> = [];
        let next = 0;

        while (next < ordered.length || window.length > 0) {
            while (next < ordered.length && window.length < Math.max(1, concurrency)) {
                window.push(Bun.zstdDecompress(readExactly(fd, ordered[next]!.compressedSize, ordered[next]!.offset)));
                next += 1;
            }

            yield await window.shift()!;
        }
    } finally {
        closeSync(fd);
    }
}

function encodeSeekTable(frames: Array<{ compressedSize: number; decompressedSize: number }>): Uint8Array {
    const tableBytes = frames.length * 8 + SEEK_FOOTER_BYTES;
    const out = Buffer.alloc(8 + tableBytes);
    out.writeUInt32LE(SEEK_TABLE_MAGIC, 0);
    out.writeUInt32LE(tableBytes, 4);

    frames.forEach((frame, index) => {
        out.writeUInt32LE(frame.compressedSize, 8 + index * 8);
        out.writeUInt32LE(frame.decompressedSize, 12 + index * 8);
    });

    const footerAt = 8 + frames.length * 8;
    out.writeUInt32LE(frames.length, footerAt);
    out.writeUInt8(0, footerAt + 4);
    out.writeUInt32LE(SEEKABLE_FOOTER_MAGIC, footerAt + 5);
    return out;
}

export interface ZstdParams {
    level?: number;
    /** Long-distance matching with a 128 MiB window: finds repeats far apart (a tree of similar files). */
    long?: boolean;
    /** A content checksum in every frame, checked by every decoder (default true). */
    checksum?: boolean;
}

function nodeParams({ level = DEFAULT_ZSTD_LEVEL, long = false, checksum = true }: ZstdParams): Record<number, number> {
    const params: Record<number, number> = {
        [zlibConstants.ZSTD_c_compressionLevel]: level,
        [zlibConstants.ZSTD_c_checksumFlag]: checksum ? 1 : 0,
    };

    if (long) {
        params[zlibConstants.ZSTD_c_enableLongDistanceMatching] = 1;
        params[zlibConstants.ZSTD_c_windowLog] = LONG_WINDOW_LOG;
    }

    return params;
}

/**
 * One frame, compressed through `node:zlib` because only it takes parameters (checksum, long mode) on Bun 1.3.13;
 * a single frame is also exactly what its decoder handles correctly there.
 */
export function compressFrameSync(frame: Uint8Array, params: ZstdParams = {}): Uint8Array {
    return zstdCompressSync(frame, { params: nodeParams(params) });
}

/** {@link compressFrameSync} on the libuv thread pool, so several frames compress at once. */
export function compressFrame(frame: Uint8Array, params: ZstdParams = {}): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        zstdCompress(frame, { params: nodeParams(params) }, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

const LONG_WINDOW_LOG = 27;

export interface SeekableWriterOptions extends ZstdParams {
    /** Receives every compressed byte, in order (a file descriptor, an atomic temp file). */
    write: (bytes: Uint8Array) => void;
    frameBytes?: number;
    /** Cut frames after a newline, so every frame starts on a line (text: logs, JSONL transcripts). */
    lineAligned?: boolean;
    /** Frames compressed at once on the thread pool (1 = inline). Memory holds about `threads × frameBytes`. */
    threads?: number;
}

export interface SeekableWriterStats {
    frames: number;
    inputBytes: number;
    outputBytes: number;
}

/**
 * Writes the zstd seekable format: input is cut into independent frames of at most `frameBytes`, each compressed on
 * its own (up to `threads` at once, written in order), and `finish()` appends the seek table. A line-aligned writer
 * cuts after the last newline in a frame (a line longer than four frames is cut anyway).
 */
export class SeekableZstdWriter {
    private readonly write: (bytes: Uint8Array) => void;
    private readonly params: ZstdParams;
    private readonly frameBytes: number;
    private readonly lineAligned: boolean;
    private readonly threads: number;
    private pending: Uint8Array[] = [];
    private pendingBytes = 0;
    private readonly inflight: Array<{ size: number; result: Promise<Uint8Array> }> = [];
    private readonly entries: Array<{ compressedSize: number; decompressedSize: number }> = [];
    private finished = false;
    readonly stats: SeekableWriterStats = { frames: 0, inputBytes: 0, outputBytes: 0 };

    constructor(options: SeekableWriterOptions) {
        this.write = options.write;
        this.params = { level: options.level, long: options.long, checksum: options.checksum };
        this.frameBytes = options.frameBytes ?? DEFAULT_FRAME_BYTES;
        this.lineAligned = options.lineAligned ?? false;
        this.threads = Math.max(1, options.threads ?? 1);
    }

    async push(bytes: Uint8Array): Promise<void> {
        if (this.finished) {
            throw new Error("SeekableZstdWriter: push after finish");
        }

        if (bytes.length === 0) {
            return;
        }

        // Copied (a memcpy; `Uint8Array.from` iterates byte by byte and cost 1.5 s of CPU per 100 MB): callers
        // reuse their read buffer for the next chunk.
        this.pending.push(new Uint8Array(bytes));
        this.pendingBytes += bytes.length;
        this.stats.inputBytes += bytes.length;

        while (this.pendingBytes >= this.frameBytes) {
            const frame = this.cutFrame(false);

            if (!frame) {
                // A long line without its newline yet: wait for more input.
                break;
            }

            await this.submit(frame);
        }
    }

    async finish(): Promise<SeekableWriterStats> {
        if (this.finished) {
            return this.stats;
        }

        while (this.pendingBytes > 0) {
            const frame = this.cutFrame(true);

            if (frame) {
                await this.submit(frame);
            }
        }

        while (this.inflight.length > 0) {
            await this.drainOne();
        }

        this.emit(encodeSeekTable(this.entries));
        this.finished = true;
        return this.stats;
    }

    private emit(bytes: Uint8Array): void {
        this.write(bytes);
        this.stats.outputBytes += bytes.length;
    }

    private emitFrame(size: number, compressed: Uint8Array): void {
        this.emit(compressed);
        this.entries.push({ compressedSize: compressed.length, decompressedSize: size });
        this.stats.frames += 1;
    }

    private async submit(frame: Uint8Array): Promise<void> {
        if (this.threads === 1) {
            this.emitFrame(frame.length, compressFrameSync(frame, this.params));
            return;
        }

        this.inflight.push({ size: frame.length, result: compressFrame(frame, this.params) });

        if (this.inflight.length >= this.threads) {
            await this.drainOne();
        }
    }

    private async drainOne(): Promise<void> {
        const head = this.inflight.shift();

        if (head) {
            this.emitFrame(head.size, await head.result);
        }
    }

    /** Takes one frame off the pending input; undefined when a line-aligned writer must wait for a newline. */
    private cutFrame(final: boolean): Uint8Array | undefined {
        const joined = Buffer.concat(this.pending);
        let cut = Math.min(joined.length, this.frameBytes);

        if (this.lineAligned && !(final && joined.length <= this.frameBytes)) {
            const before = joined.lastIndexOf(10, cut - 1);
            const after = before === -1 ? joined.indexOf(10, cut) : -1;

            if (before !== -1) {
                cut = before + 1;
            } else if (after !== -1) {
                cut = after + 1;
            } else if (!final && joined.length < this.frameBytes * 4) {
                this.pending = [joined];
                return undefined;
            }
        }

        const rest = joined.subarray(cut);
        this.pending = rest.length > 0 ? [rest] : [];
        this.pendingBytes = rest.length;
        return joined.subarray(0, cut);
    }
}
