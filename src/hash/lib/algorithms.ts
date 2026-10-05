export const ALGOS = ["md5", "sha1", "sha256", "sha512", "blake3"] as const;

export type HashAlgo = (typeof ALGOS)[number];

export interface Hasher {
    update(chunk: Uint8Array): void;
    digestHex(): string;
}

type NativeAlgo = Exclude<HashAlgo, "blake3">;

export const HEX_LENGTH: Record<HashAlgo, number> = {
    md5: 32,
    sha1: 40,
    sha256: 64,
    sha512: 128,
    blake3: 64,
};

const TAG_NAMES: Record<string, HashAlgo> = {
    MD5: "md5",
    SHA1: "sha1",
    SHA256: "sha256",
    SHA512: "sha512",
    BLAKE3: "blake3",
};

export function isHashAlgo(value: string): value is HashAlgo {
    return (ALGOS as readonly string[]).includes(value);
}

/** The algorithm a hex digest of this length belongs to; 64 digits is sha256, since blake3 shares that length. */
export function algoForHexLength(length: number): HashAlgo | undefined {
    return ALGOS.find((algo) => algo !== "blake3" && HEX_LENGTH[algo] === length);
}

/** The algorithm named by a BSD-style tag (`SHA256 (file) = hex`). */
export function algoForTag(tag: string): HashAlgo | undefined {
    return TAG_NAMES[tag.toUpperCase()];
}

function isNativeAlgo(algo: HashAlgo): algo is NativeAlgo {
    return algo !== "blake3";
}

/**
 * md5, sha1, sha256 and sha512 run on the runtime's native hasher, which was 8 to 12 times faster than WebAssembly
 * on a 600 MB file. blake3 is not among Bun.CryptoHasher.algorithms (Bun 1.4.2), so it stays on hash-wasm, loaded
 * only when asked for.
 */
export async function createHasher(algo: HashAlgo): Promise<Hasher> {
    if (isNativeAlgo(algo)) {
        const native = new Bun.CryptoHasher(algo);
        return {
            update(chunk) {
                native.update(chunk);
            },
            digestHex: () => native.digest("hex"),
        };
    }

    const { createBLAKE3 } = await import("hash-wasm");
    const wasm = await createBLAKE3();
    wasm.init();
    return {
        update(chunk) {
            wasm.update(chunk);
        },
        digestHex: () => wasm.digest("hex"),
    };
}
