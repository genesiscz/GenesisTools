import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { type AttributedEvent, type SessionShare, sharesIn } from "./spend-share";

/** `usage.limits.attribution@1`. */
export const LIMITS_ATTRIBUTION_SCHEMA = { verb: "limits.attribution", version: 1 } as const;

export interface ProjectSlice {
    project: string;
    costUsd: number;
    share: number;
    /** Percentage points of the bar, at the account's dollars per point. */
    barPercent: number;
}

export interface BarSessionShare extends SessionShare {
    barPercent: number;
}

/** "Who ate the bar" for one account and window: the rise since the start, split by project and session. */
export interface BarAttribution {
    account: AccountKey;
    kind: string | null;
    key: string;
    /** ISO UTC: the last reset of the window, or the asked start when no reset fell inside the range. */
    since: string;
    sinceReset: boolean;
    /** The sum of the rises since `since` (a reset's drop is not use). */
    risePercent: number;
    current: number | null;
    /** Dollars of attributed spend per percentage point; null when nothing rose or nothing was priced. */
    usdPerPercent: number | null;
    totalUsd: number;
    unpriced: number;
    projects: ProjectSlice[];
    sessions: BarSessionShare[];
    unattributed: { costUsd: number; tokens: number; share: number; barPercent: number };
}

export interface AttributionData {
    bars: BarAttribution[];
}

/** The latest reset in the series, ISO UTC; undefined when none fell inside the range read. */
export function lastReset(entry: SeriesEntry, now: Date): string | undefined {
    return entry.resets
        .filter((reset) => Date.parse(reset) <= now.getTime())
        .sort()
        .at(-1);
}

/**
 * The sum of every rise between readings at or after `since`. Across a reset the base is 0, not the old cycle's last
 * reading, so the use before the first reading after it counts; any other drop (a correction) adds nothing.
 */
export function riseSince(entry: SeriesEntry, since: number): number {
    const resets = entry.resets.map((reset) => Date.parse(reset));
    let rise = 0;
    let previous: { t: number; percent: number } | undefined;

    for (const point of entry.points) {
        const t = Date.parse(point.t);

        if (t >= since && previous !== undefined) {
            const prior = previous.t;
            const base = resets.some((reset) => prior < reset && reset <= t) ? 0 : previous.percent;
            rise += Math.max(0, point.percent - base);
        }

        previous = { t, percent: point.percent };
    }

    return rise;
}

export function attributeBar(input: {
    entry: SeriesEntry;
    account: AccountKey;
    events: readonly AttributedEvent[];
    /** The asked start, used when no reset fell inside the range. */
    from: Date;
    /** The range's end (`--until`, or now): a reset or a dollar after it is outside the bar it explains. */
    to: Date;
    reportCommand: (sessionId: string) => string;
}): BarAttribution {
    const reset = lastReset(input.entry, input.to);
    const since =
        reset !== undefined && Date.parse(reset) > input.from.getTime() ? Date.parse(reset) : input.from.getTime();
    const shares = sharesIn({
        events: input.events,
        account: input.account,
        from: since,
        to: input.to.getTime(),
        reportCommand: input.reportCommand,
    });
    const risePercent = riseSince(input.entry, since);
    const usdPerPercent = risePercent > 0 && shares.totalUsd > 0 ? shares.totalUsd / risePercent : null;
    const barOf = (usd: number): number => (usdPerPercent ? usd / usdPerPercent : 0);
    const projects = new Map<string, ProjectSlice>();

    for (const session of shares.sessions) {
        const slice = projects.get(session.project) ?? {
            project: session.project,
            costUsd: 0,
            share: 0,
            barPercent: 0,
        };
        slice.costUsd += session.costUsd;
        projects.set(session.project, slice);
    }

    for (const slice of projects.values()) {
        slice.share = shares.totalUsd > 0 ? slice.costUsd / shares.totalUsd : 0;
        slice.barPercent = barOf(slice.costUsd);
    }

    return {
        account: input.account,
        kind: input.entry.kind,
        key: input.entry.key,
        since: new Date(since).toISOString(),
        sinceReset: since !== input.from.getTime(),
        risePercent,
        current: input.entry.points.at(-1)?.percent ?? null,
        usdPerPercent,
        totalUsd: shares.totalUsd,
        unpriced: shares.unpriced,
        projects: [...projects.values()].sort((a, b) => b.costUsd - a.costUsd),
        sessions: shares.sessions.map((session) => ({ ...session, barPercent: barOf(session.costUsd) })),
        unattributed: { ...shares.unattributed, barPercent: barOf(shares.unattributed.costUsd) },
    };
}
