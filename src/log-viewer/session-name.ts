/** Chars allowed in log session names on disk and in dashboard /log/* routes.
 *  Collision suffixes use dashes (metro-2026-05-26_14-30-22) so names stay
 *  NTFS-safe — `:` would break Windows filename rules and was removed. */
export const SAFE_LOG_SESSION_NAME = /^[a-zA-Z0-9_-]+$/;

export function isSafeLogSessionName(name: string): boolean {
    if (!name) {
        return false;
    }

    return SAFE_LOG_SESSION_NAME.test(name);
}

export function decodeSessionPathSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}
