/**
 * Fast non-cryptographic hash using Bun's built-in xxHash64.
 * Returns a hex string.
 */
export function xxhash(content: string): string {
    return Bun.hash.xxHash64(content).toString(16);
}

export type IntegrityVerification =
    | { status: "verified" }
    | { status: "missing" }
    | { status: "unsupported"; algorithm: string }
    | { status: "mismatch"; expected: string; actual: string };

/**
 * Verify bytes against a Subresource-Integrity-style hash string (`<algorithm>-<base64digest>`,
 * e.g. npm's `dist.integrity` or an HTML `integrity` attribute). Only `sha512` is checked —
 * other algorithms are reported as `unsupported` rather than silently skipped, and a missing
 * hash is reported as `missing`, so callers can decide how loudly to warn.
 */
export function verifySriIntegrity(bytes: Uint8Array, integrity?: string): IntegrityVerification {
    if (integrity === undefined) {
        return { status: "missing" };
    }

    if (integrity.startsWith("sha512-")) {
        const hasher = new Bun.CryptoHasher("sha512");
        hasher.update(bytes);
        const actual = hasher.digest("base64");
        const expected = integrity.slice("sha512-".length);
        return actual === expected ? { status: "verified" } : { status: "mismatch", expected, actual };
    }

    return { status: "unsupported", algorithm: integrity.split("-")[0] ?? integrity };
}
