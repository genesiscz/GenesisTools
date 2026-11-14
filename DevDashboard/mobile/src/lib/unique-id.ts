/**
 * A short id that is unique on this phone: `<prefix>-<ms since epoch, base 36>-<random base-36 suffix>`. With a
 * `[A-Za-z0-9._]` prefix it is also a valid SecureStore key. Not a secret: `Math.random` only keeps two ids made in
 * the same millisecond apart.
 */
export function uniqueId(prefix: string, randomLength = 8): string {
    const random = Math.random()
        .toString(36)
        .slice(2, 2 + randomLength);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
}
