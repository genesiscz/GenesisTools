// Use `-` between time fields (not `:`) so collision-suffixed names remain
// valid NTFS filenames AND match the SAFE_LOG_SESSION_NAME charset enforced
// at the dashboard route layer. See utils/log-viewer/session-name.ts.
const COLLISION_SUFFIX = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

export function formatSessionDatetimeSuffix(date = new Date()): string {
    const pad = (value: number, length = 2): string => {
        return String(value).padStart(length, "0");
    };

    const y = date.getFullYear();
    const mo = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const s = pad(date.getSeconds());

    return `${y}-${mo}-${d}_${h}-${mi}-${s}`;
}

export function buildTimestampedSessionName(base: string, date = new Date()): string {
    return `${base}-${formatSessionDatetimeSuffix(date)}`;
}

export function isRelatedSessionName(base: string, candidate: string): boolean {
    if (candidate === base) {
        return true;
    }

    if (!candidate.startsWith(`${base}-`)) {
        return false;
    }

    const suffix = candidate.slice(base.length + 1);
    return COLLISION_SUFFIX.test(suffix);
}
