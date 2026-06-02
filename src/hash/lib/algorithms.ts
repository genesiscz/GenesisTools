import { createBLAKE3, createMD5, createSHA1, createSHA256, createSHA512, type IHasher } from "hash-wasm";

export const ALGOS = ["md5", "sha1", "sha256", "sha512", "blake3"] as const;

export type HashAlgo = (typeof ALGOS)[number];

const FACTORIES: Record<HashAlgo, () => Promise<IHasher>> = {
    md5: createMD5,
    sha1: createSHA1,
    sha256: createSHA256,
    sha512: createSHA512,
    blake3: () => createBLAKE3(),
};

export function isHashAlgo(value: string): value is HashAlgo {
    return (ALGOS as readonly string[]).includes(value);
}

export async function createHasher(algo: HashAlgo): Promise<IHasher> {
    const factory = FACTORIES[algo];
    return factory();
}
