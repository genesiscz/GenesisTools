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
    const ageSec = Math.floor(ageMs / SECOND);

    if (ageSec < 10) {
        return {
            tier: "hot",
            relative: ageSec < 1 ? "just now" : `${ageSec}s ago`,
            ageMs,
        };
    }

    if (ageSec < 30) {
        return { tier: "fresh", relative: `${ageSec}s ago`, ageMs };
    }

    if (ageSec < 60) {
        return { tier: "recent", relative: `${ageSec}s ago`, ageMs };
    }

    const ageMin = Math.floor(ageMs / MINUTE);

    if (ageMin < 5) {
        return { tier: "warm", relative: `${ageMin}m ago`, ageMs };
    }

    if (ageMin < 15) {
        return { tier: "cool", relative: `${ageMin}m ago`, ageMs };
    }

    const ageHours = Math.floor(ageMs / HOUR);

    if (ageHours < 1) {
        return { tier: "cool", relative: `${ageMin}m ago`, ageMs };
    }

    if (ageHours < 24) {
        return { tier: "muted", relative: `${ageHours}h ago`, ageMs };
    }

    const ageDays = Math.floor(ageMs / DAY);

    return { tier: "stale", relative: `${ageDays}d ago`, ageMs };
}
