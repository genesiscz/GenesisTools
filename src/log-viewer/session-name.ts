/** Chars allowed in log session names on disk and in dashboard /log/* routes.
 *  Collision suffixes use dashes (metro-2026-05-26_14-30-22) so names stay
 *  NTFS-safe — `:` would break Windows filename rules and was removed.
 *
 *  Dots are allowed in the interior (reg-device-288060.backup-fix-023257):
 *  session managers hand out dotted names, and rejecting them here made those
 *  sessions invisible to GET /api/sessions and un-deletable via DELETE (400)
 *  while `tools debugging-master sessions` still listed them. Traversal stays
 *  blocked because `/` and `\` are outside the charset and a name may neither
 *  start nor end with a dot, so `.`, `..` and `foo.` are all rejected. */
export const SAFE_LOG_SESSION_NAME = /^[a-zA-Z0-9_-](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_-])?$/;

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
