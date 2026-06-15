import { createHasher, type HashAlgo } from "./algorithms";

export interface HashChunksArgs {
    algo: HashAlgo;
    chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}

export async function hashChunks({ algo, chunks }: HashChunksArgs): Promise<string> {
    const hasher = await createHasher(algo);
    hasher.init();

    for await (const chunk of chunks) {
        hasher.update(chunk);
    }

    return hasher.digest("hex");
}

export async function hashBuffer(algo: HashAlgo, data: Uint8Array): Promise<string> {
    return hashChunks({ algo, chunks: [data] });
}
