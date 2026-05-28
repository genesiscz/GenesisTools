export type QaRecencyTier = "hot" | "fresh" | "recent" | "warm" | "cool" | "muted" | "stale";

export interface QaRecency {
    tier: QaRecencyTier;
    relative: string;
    ageMs: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function resolveQaRecency(ts: number, now = Date.now()): QaRecency {
    const ageMs = Math.max(0, now - ts);
    const secs = Math.floor(ageMs / SECOND);

    if (secs < 5) {
        return { tier: "hot", relative: "just now", ageMs };
    }

    if (secs < 60) {
        return { tier: "hot", relative: `${secs}s ago`, ageMs };
    }

    const mins = Math.floor(secs / 60);
    const remainderSecs = secs - mins * 60;

    if (mins < 60) {
        const tier: QaRecencyTier = mins < 5 ? "fresh" : mins < 30 ? "recent" : "warm";
        const relative = remainderSecs === 0 ? `${mins}m ago` : `${mins}m ${remainderSecs}s ago`;

        return { tier, relative, ageMs };
    }

    const ageHours = Math.floor(ageMs / HOUR);

    if (ageHours < 24) {
        return { tier: "muted", relative: `${ageHours}h ago`, ageMs };
    }

    const ageDays = Math.floor(ageMs / DAY);

    if (ageDays < 7) {
        return { tier: "cool", relative: `${ageDays}d ago`, ageMs };
    }

    if (ageDays < 30) {
        return { tier: "stale", relative: `${ageDays}d ago`, ageMs };
    }

    return { tier: "stale", relative: `${Math.floor(ageDays / 7)}w ago`, ageMs };
}
