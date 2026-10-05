import { open } from "node:fs/promises";
import { createHasher, type HashAlgo } from "./algorithms";

const READ_CHUNK_BYTES = 1024 * 1024;

export interface HashChunksArgs {
    algo: HashAlgo;
    chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}

export async function hashChunks({ algo, chunks }: HashChunksArgs): Promise<string> {
    const hasher = await createHasher(algo);

    for await (const chunk of chunks) {
        hasher.update(chunk);
    }

    return hasher.digestHex();
}

export async function hashBuffer(algo: HashAlgo, data: Uint8Array): Promise<string> {
    return hashChunks({ algo, chunks: [data] });
}

/** Hashes a file through one reused 1 MiB buffer, so memory stays flat however large the file is. */
export async function hashFile(algo: HashAlgo, path: string): Promise<string> {
    const hasher = await createHasher(algo);
    const handle = await open(path, "r");

    try {
        const { size } = await handle.stat();
        const buffer = Buffer.allocUnsafe(size > 0 && size < READ_CHUNK_BYTES ? size : READ_CHUNK_BYTES);

        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }

            hasher.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        await handle.close();
    }

    return hasher.digestHex();
}

export function hashStdin(algo: HashAlgo): Promise<string> {
    return hashChunks({ algo, chunks: Bun.stdin.stream() });
}

/** The reason a read failed, worded as coreutils words it. */
export function describeReadError(error: unknown): string {
    const code = error instanceof Error && "code" in error ? error.code : undefined;

    if (code === "ENOENT") {
        return "No such file or directory";
    }

    if (code === "EACCES" || code === "EPERM") {
        return "Permission denied";
    }

    if (code === "EISDIR") {
        return "Is a directory";
    }

    return error instanceof Error ? error.message : String(error);
}
