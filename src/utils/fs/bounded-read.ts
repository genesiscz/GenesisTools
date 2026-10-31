import { constants } from "node:fs";
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

/**
 * Reads a regular file of at most `maxBytes`. The open is nonblocking, so a FIFO with no writer cannot hold the
 * caller, and the opened file (not the path) is checked; the read stays bounded when the file grows after the stat.
 */
export async function readBoundedRegularFile(path: string, options: BoundedReadOptions): Promise<Buffer> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (options.noFollow ? constants.O_NOFOLLOW : 0);
    const file = await open(path, flags);

    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > options.maxBytes) {
            throw new Error(options.tooLarge);
        }

        const chunks: Buffer[] = [];
        let length = 0;

        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
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
