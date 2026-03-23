/**
 * Fast non-cryptographic hash using Bun's built-in xxHash64.
 * Returns a hex string.
 */
export function xxhash(content: string): string {
    return Bun.hash(content).toString(16);
}
