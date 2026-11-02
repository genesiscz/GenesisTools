import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

export interface BoundedReadOptions {
    maxBytes: number;
    /** Thrown when the path is not a regular file or is larger than maxBytes when opened. */
    tooLarge: string;
    /** Thrown when the file grew past maxBytes while it was read. */
    grew: string;
    /** Refuse a symlink as the last path component. */
    noFollow?: boolean;
    signal?: AbortSignal;
}

const CHUNK_BYTES = 64 * 1024;

function openFlags(options: Pick<BoundedReadOptions, "noFollow">): number {
    return constants.O_RDONLY | constants.O_NONBLOCK | (options.noFollow ? constants.O_NOFOLLOW : 0);
}

/**
 * Reads a regular file of at most `maxBytes`. The open is nonblocking, so a FIFO with no writer cannot hold the
 * caller, and the opened file (not the path) is checked; the read stays bounded when the file grows after the stat.
 */
export async function readBoundedRegularFile(path: string, options: BoundedReadOptions): Promise<Buffer> {
    const file = await open(path, openFlags(options));

    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > options.maxBytes) {
            throw new Error(options.tooLarge);
        }

        const chunks: Buffer[] = [];
        let length = 0;

        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: CHUNK_BYTES })) {
            options.signal?.throwIfAborted();
            length += chunk.length;

            if (length > options.maxBytes) {
                throw new Error(options.grew);
            }

            chunks.push(chunk);
        }

        return Buffer.concat(chunks, length);
    } finally {
        await file.close();
    }
}

/**
 * {@link readBoundedRegularFile} for a synchronous caller (a scan that must not await): the same nonblocking open, the
 * same check of the opened file, the same bound while it reads.
 */
export function readBoundedRegularFileSync(path: string, options: Omit<BoundedReadOptions, "signal">): Buffer {
    const fd = openSync(path, openFlags(options));

    try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > options.maxBytes) {
            throw new Error(options.tooLarge);
        }

        const chunks: Buffer[] = [];
        let length = 0;

        while (true) {
            const chunk = Buffer.alloc(CHUNK_BYTES);
            const read = readSync(fd, chunk, 0, CHUNK_BYTES, null);

            if (read === 0) {
                break;
            }

            length += read;

            if (length > options.maxBytes) {
                throw new Error(options.grew);
            }

            chunks.push(chunk.subarray(0, read));
        }

        return Buffer.concat(chunks, length);
    } finally {
        closeSync(fd);
    }
}
