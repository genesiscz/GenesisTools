import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { type AttributedEvent, type SpanShares, sharesIn } from "./spend-share";

/** `usage.limits.spikes@1`. */
export const LIMITS_SPIKES_SCHEMA = { verb: "limits.spikes", version: 1 } as const;

export interface SpikeSettings {
    /** A rise of at least this many percentage points... */
    minDelta: number;
    /** ...within this many minutes. */
    windowMinutes: number;
    /** Spend this many minutes before the first reading counts too: a poll sees a call only after it ran. */
    padMinutes: number;
}

export const SPIKE_DEFAULTS: SpikeSettings = { minDelta: 5, windowMinutes: 10, padMinutes: 5 };

export interface Spike extends SpanShares {
    account: AccountKey;
    /** Window kind (`session`, `weekly`) and the provider's native key. */
    kind: string | null;
    key: string;
    /** ISO UTC of the reading the rise started from, and of the reading it peaked at. */
    from: string;
    to: string;
    startPercent: number;
    endPercent: number;
    delta: number;
}

export interface SpikesData {
    settings: SpikeSettings;
    spikes: Spike[];
}

interface Rise {
    from: { t: string; v: number };
    to: { t: string; v: number };
}

/**
 * The rises of one window series: a reading that sits at least `minDelta` above the lowest reading of the
 * `windowMinutes` before it, inside one reset cycle. Overlapping rises merge into one spike from its low to its peak.
 */
export function findRises(entry: SeriesEntry, settings: SpikeSettings): Rise[] {
    const span = settings.windowMinutes * 60_000;
    const points = entry.points.map((point) => ({ at: Date.parse(point.t), t: point.t, v: point.percent }));
    const rises: Rise[] = [];

    for (let i = 1; i < points.length; i++) {
        const head = points[i];
        let low = head;

        for (let j = i - 1; j >= 0 && head.at - points[j].at <= span; j--) {
            const point = points[j];

            // A drop is a reset (or a correction): a reading before it is not the base of this rise.
            if (
                point.v > points[j + 1].v ||
                entry.resets.some((reset) => {
                    const at = Date.parse(reset);
                    return at > point.at && at <= points[j + 1].at;
                })
            ) {
                break;
            }

            if (point.v <= low.v) {
                low = point;
            }
        }

        if (head.v - low.v < settings.minDelta) {
            continue;
        }

        const last = rises.at(-1);

        if (last && Date.parse(last.to.t) >= low.at) {
            if (head.v > last.to.v) {
                last.to = { t: head.t, v: head.v };
            }

            continue;
        }

        rises.push({ from: { t: low.t, v: low.v }, to: { t: head.t, v: head.v } });
    }

    return rises;
}

/** Every spike of the series, largest first, each with the sessions that spent on its account in its span. */
export function findSpikes(input: {
    series: readonly SeriesEntry[];
    events: readonly AttributedEvent[];
    accountOf: (entry: SeriesEntry) => AccountKey;
    settings: SpikeSettings;
    reportCommand: (sessionId: string) => string;
}): Spike[] {
    const spikes: Spike[] = [];
    const pad = input.settings.padMinutes * 60_000;

    for (const entry of input.series) {
        const account = input.accountOf(entry);

        for (const rise of findRises(entry, input.settings)) {
            const shares = sharesIn({
                events: input.events,
                account,
                from: Date.parse(rise.from.t) - pad,
                to: Date.parse(rise.to.t),
                reportCommand: input.reportCommand,
            });
            spikes.push({
                account,
                kind: entry.kind,
                key: entry.key,
                from: rise.from.t,
                to: rise.to.t,
                startPercent: rise.from.v,
                endPercent: rise.to.v,
                delta: rise.to.v - rise.from.v,
                ...shares,
            });
        }
    }

    return spikes.sort((a, b) => b.delta - a.delta || Date.parse(a.from) - Date.parse(b.from));
}
