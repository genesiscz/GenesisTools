/** Chars allowed in log session names on disk and in dashboard /log/* routes. Includes `:` for task collision timestamps (e.g. metro-2026-05-26_14:30:22). */
export const SAFE_LOG_SESSION_NAME = /^[a-zA-Z0-9_:\-]+$/;

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
