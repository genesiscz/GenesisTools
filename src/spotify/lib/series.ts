/**
 * Time series over plays: the shared machinery behind sparklines, timelines and anything
 * that asks "how did this change".
 */
import { type Bucket, bucketOf, type Play } from "@app/spotify/lib/history";

export function bucketKeys(plays: Play[], tz: string, bucket: Bucket): string[] {
    const seen = new Set<string>();
    for (const p of plays) {
        seen.add(bucketOf(p.ts, tz, bucket));
    }

    return [...seen].sort();
}

/** Every bucket between the first and last play, including the empty ones. */
export function denseBuckets(plays: Play[], tz: string, bucket: Bucket): string[] {
    const keys = bucketKeys(plays, tz, bucket);
    if (keys.length < 2 || bucket === "week") {
        return keys;
    }

    const out: string[] = [];
    const first = keys[0]!;
    const last = keys[keys.length - 1]!;

    if (bucket === "year") {
        for (let y = Number(first); y <= Number(last); y++) {
            out.push(String(y));
        }

        return out;
    }

    if (bucket === "quarter") {
        let [y, q] = [Number(first.slice(0, 4)), Number(first.slice(6))];
        const [ey, eq] = [Number(last.slice(0, 4)), Number(last.slice(6))];
        while (y < ey || (y === ey && q <= eq)) {
            out.push(`${y}-Q${q}`);
            q++;
            if (q > 4) {
                q = 1;
                y++;
            }
        }

        return out;
    }

    if (bucket === "month") {
        let [y, m] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))];
        const [ey, em] = [Number(last.slice(0, 4)), Number(last.slice(5, 7))];
        while (y < ey || (y === ey && m <= em)) {
            out.push(`${y}-${String(m).padStart(2, "0")}`);
            m++;
            if (m > 12) {
                m = 1;
                y++;
            }
        }

        return out;
    }

    for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86400000) {
        out.push(new Date(t).toISOString().slice(0, 10));
    }

    return out;
}

export type Metric = "plays" | "ms";

export function seriesByKey(
    plays: Play[],
    keyOf: (p: Play) => string,
    tz: string,
    bucket: Bucket,
    metric: Metric = "plays"
): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const p of plays) {
        const k = keyOf(p);
        let inner = out.get(k);
        if (!inner) {
            inner = new Map();
            out.set(k, inner);
        }

        const b = bucketOf(p.ts, tz, bucket);
        inner.set(b, (inner.get(b) ?? 0) + (metric === "ms" ? p.ms : 1));
    }

    return out;
}

export function totalSeries(plays: Play[], tz: string, bucket: Bucket, metric: Metric = "plays"): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of plays) {
        const b = bucketOf(p.ts, tz, bucket);
        out.set(b, (out.get(b) ?? 0) + (metric === "ms" ? p.ms : 1));
    }

    return out;
}

export const dense = (m: Map<string, number>, keys: string[]): number[] => keys.map((k) => m.get(k) ?? 0);

/** Sparklines get unreadable past a couple of dozen points; fold neighbours instead. */
export function downsample(values: number[], maxPoints: number): number[] {
    if (values.length <= maxPoints) {
        return values;
    }

    const size = Math.ceil(values.length / maxPoints);
    const out: number[] = [];
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size).reduce((a, b) => a + b, 0));
    }

    return out;
}

/**
 * Labels for a `downsample()` of the same length, so a chart can axis-label folded points.
 * Each fold is labelled by the bucket it starts at.
 */
export function downsampleKeys(keys: string[], maxPoints: number): string[] {
    if (keys.length <= maxPoints) {
        return keys;
    }

    const size = Math.ceil(keys.length / maxPoints);
    const out: string[] = [];
    for (let i = 0; i < keys.length; i += size) {
        out.push(keys[i]!);
    }

    return out;
}

/** Picks the bucket that yields a readable number of points for the window at hand. */
export function autoBucket(plays: Play[]): Bucket {
    if (!plays.length) {
        return "month";
    }

    const spanDays = (plays[plays.length - 1]!.ts - plays[0]!.ts) / 86400000;
    if (spanDays <= 62) {
        return "day";
    }

    if (spanDays <= 400) {
        return "week";
    }

    if (spanDays <= 1500) {
        return "month";
    }

    return "quarter";
}
