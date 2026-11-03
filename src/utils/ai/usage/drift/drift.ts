import type { Database } from "bun:sqlite";
import type { AttributedEvent } from "@genesiscz/utils/ai/usage/attribution/spend-share";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract";
import { spendBucketKey } from "@genesiscz/utils/ai/usage/series-keys";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";

/**
 * Limit drift (design 2026-11-01, step U12, proposal 13): what one percentage point of a window buys, in tokens and
 * list-price dollars, per account, model and week, measured over exclusive windows (the account's bar rose and no
 * other account of its provider rose around it), with a 95 % bootstrap interval. A week whose interval does not
 * overlap the earlier weeks' marks the account "limit cut?" or "limit raised?". The helpers are ported from the
 * session-analyzer skill's `drain-rate.ts` as they were.
 */
export const LIMITS_DRIFT_SCHEMA = { verb: "limits.drift", version: 1 } as const;

export interface DriftReading {
    ts: number;
    account: string;
    util: number;
}

export interface DriftWindow {
    from: number;
    to: number;
    delta: number;
}

/** Windows where the target's bar rose and nobody else's did within `padMs` around it. */
export function exclusiveWindows(
    rows: readonly DriftReading[],
    target: string,
    opts: { padMs: number; maxWindowMs: number }
): DriftWindow[] {
    const mine = rows.filter((row) => row.account === target);
    const otherRises: number[] = [];
    const last = new Map<string, number>();

    for (const row of rows) {
        if (row.account === target) {
            continue;
        }

        const previous = last.get(row.account);

        if (previous !== undefined && row.util > previous) {
            otherRises.push(row.ts);
        }

        last.set(row.account, row.util);
    }

    otherRises.sort((a, b) => a - b);
    const windows: DriftWindow[] = [];

    for (let i = 1; i < mine.length; i++) {
        const a = mine[i - 1];
        const b = mine[i];
        const delta = b.util - a.util;

        // A drop is a reset or a flat re-poll, never use.
        if (delta <= 0 || b.ts - a.ts > opts.maxWindowMs) {
            continue;
        }

        if (otherRises.some((t) => t > a.ts - opts.padMs && t <= b.ts + opts.padMs)) {
            continue;
        }

        windows.push({ from: a.ts, to: b.ts, delta });
    }

    return windows;
}

export interface Sample {
    delta: number;
    value: number;
}

/** Pooled ratio: sum(value) / sum(delta). */
export function pooled(samples: readonly Sample[]): number {
    const delta = samples.reduce((sum, sample) => sum + sample.delta, 0);
    return delta > 0 ? samples.reduce((sum, sample) => sum + sample.value, 0) / delta : 0;
}

/**
 * 95 % bootstrap interval of the pooled ratio, resampling windows (the independent unit). A deterministic generator:
 * two runs over the same data report the same interval.
 */
export function bootstrapCI(samples: readonly Sample[], iterations = 4000, seed = 987654321): [number, number] {
    if (samples.length < 2) {
        return [Number.NaN, Number.NaN];
    }

    let state = seed;
    const random = (): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
    const ratios: number[] = [];

    for (let i = 0; i < iterations; i++) {
        let value = 0;
        let delta = 0;

        for (let j = 0; j < samples.length; j++) {
            const pick = samples[(random() * samples.length) | 0];
            value += pick.value;
            delta += pick.delta;
        }

        if (delta > 0) {
            ratios.push(value / delta);
        }
    }

    ratios.sort((a, b) => a - b);
    return [ratios[Math.floor(ratios.length * 0.025)], ratios[Math.floor(ratios.length * 0.975)]];
}

export function ciOverlap(a: [number, number], b: [number, number]): boolean {
    if (Number.isNaN(a[0]) || Number.isNaN(b[0])) {
        return true;
    }

    return a[0] <= b[1] && b[0] <= a[1];
}

export interface DriftSettings {
    padMinutes: number;
    maxWindowMinutes: number;
    /** A week needs this many exclusive windows for a number; fewer reads "insufficient". */
    minWindows: number;
    /** A window's calls count for one model when it has this share of the tokens; else they go to "mixed". */
    modelShare: number;
}

export const DRIFT_DEFAULTS: DriftSettings = { padMinutes: 5, maxWindowMinutes: 120, minWindows: 5, modelShare: 0.9 };

export interface DriftWeek {
    /** The Monday of the week, local. */
    week: string;
    windows: number;
    tokensPerPct: number | null;
    usdPerPct: number | null;
    ci: [number, number] | null;
    status: "ok" | "insufficient";
}

export type DriftVerdict = "steady" | "limit cut?" | "limit raised?" | "insufficient";

export interface DriftRow {
    account: AccountKey;
    kind: string | null;
    model: string;
    weeks: DriftWeek[];
    baseline: { tokensPerPct: number; ci: [number, number] } | null;
    verdict: DriftVerdict;
}

export interface DriftData {
    settings: DriftSettings;
    rows: DriftRow[];
}

interface WindowSample {
    week: string;
    model: string;
    tokens: Sample;
    usd: Sample;
}

function sameAccount(a: AccountKey, b: AccountKey): boolean {
    return a.provider === b.provider && (a.accountId === b.accountId || a.accountName === b.accountName);
}

function weekOf(samples: readonly WindowSample[], week: string, settings: DriftSettings): DriftWeek {
    const list = samples.filter((sample) => sample.week === week);
    const ok = list.length >= settings.minWindows;
    const ci = ok ? bootstrapCI(list.map((sample) => sample.tokens)) : null;

    return {
        week,
        windows: list.length,
        tokensPerPct: ok ? pooled(list.map((sample) => sample.tokens)) : null,
        usdPerPct: ok ? pooled(list.map((sample) => sample.usd)) : null,
        ci: ci && !Number.isNaN(ci[0]) ? ci : null,
        status: ok ? "ok" : "insufficient",
    };
}

/** The drift rows of one provider's series of one window kind. */
export function computeDrift(input: {
    series: readonly SeriesEntry[];
    events: readonly AttributedEvent[];
    accountOf: (entry: SeriesEntry) => AccountKey;
    settings: DriftSettings;
    tz: string;
}): DriftRow[] {
    const { settings } = input;
    const readings: DriftReading[] = input.series
        .flatMap((entry) =>
            entry.points.map((point) => ({
                ts: Date.parse(point.t),
                account: `${entry.provider}\u0000${entry.account}`,
                util: point.percent,
            }))
        )
        .sort((a, b) => a.ts - b.ts);
    const rows: DriftRow[] = [];

    for (const entry of input.series) {
        const account = input.accountOf(entry);
        const ownEvents = input.events.filter(
            (event) => event.account.account !== undefined && sameAccount(event.account.account, account)
        );
        const target = `${entry.provider}\u0000${entry.account}`;
        const peers = readings.filter((reading) => reading.account.startsWith(`${entry.provider}\u0000`));
        const windows = exclusiveWindows(peers, target, {
            padMs: settings.padMinutes * 60_000,
            maxWindowMs: settings.maxWindowMinutes * 60_000,
        });
        const samples: WindowSample[] = [];

        for (const window of windows) {
            const byModel = new Map<string, { tokens: number; usd: number }>();

            for (const event of ownEvents) {
                if (event.at <= window.from || event.at > window.to) {
                    continue;
                }

                const model = byModel.get(event.model ?? "?") ?? { tokens: 0, usd: 0 };
                model.tokens += event.tokens;
                model.usd += event.costUsd;
                byModel.set(event.model ?? "?", model);
            }

            const tokens = [...byModel.values()].reduce((sum, value) => sum + value.tokens, 0);

            // A rise with no spend of this account in it is another host's work; it says nothing about the rate.
            if (tokens === 0) {
                continue;
            }

            const usd = [...byModel.values()].reduce((sum, value) => sum + value.usd, 0);
            const [top, share] = [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens)[0];
            const week = spendBucketKey(new Date(window.to).toISOString(), "week", input.tz);
            const sample = {
                week,
                tokens: { delta: window.delta, value: tokens },
                usd: { delta: window.delta, value: usd },
            };
            samples.push({ ...sample, model: "all" });

            if (share.tokens >= settings.modelShare * tokens) {
                samples.push({ ...sample, model: top });
            }
        }

        for (const model of [...new Set(samples.map((sample) => sample.model))]) {
            const mine = samples.filter((sample) => sample.model === model);
            const weekKeys = [...new Set(mine.map((sample) => sample.week))].sort();
            const weeks = weekKeys.map((week) => weekOf(mine, week, settings));
            const latest = [...weeks].reverse().find((week) => week.status === "ok");
            const earlier = latest ? mine.filter((sample) => sample.week < latest.week) : [];
            const baselineCi = earlier.length >= settings.minWindows ? bootstrapCI(earlier.map((s) => s.tokens)) : null;
            const baseline =
                baselineCi && !Number.isNaN(baselineCi[0])
                    ? { tokensPerPct: pooled(earlier.map((s) => s.tokens)), ci: baselineCi }
                    : null;
            let verdict: DriftVerdict = "insufficient";

            if (latest?.ci && baseline) {
                verdict = ciOverlap(latest.ci, baseline.ci)
                    ? "steady"
                    : (latest.tokensPerPct ?? 0) < baseline.tokensPerPct
                      ? "limit cut?"
                      : "limit raised?";
            } else if (latest) {
                verdict = "steady";
            }

            rows.push({ account, kind: entry.kind, model, weeks, baseline, verdict });
        }
    }

    return rows;
}

/** Writes this run's weeks into `limit_drift` (the table of `USAGE_LIMITS_MIGRATIONS`), one row per account, model, week. */
export function recordDrift(db: Database, rows: readonly DriftRow[], now: Date): number {
    const statement = db.prepare(
        `INSERT INTO limit_drift
            (provider, account_id, account_name, kind, model, week, windows, tokens_per_pct, usd_per_pct, ci_low, ci_high,
             status, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, account_name, kind, model, week) DO UPDATE SET
            account_id = excluded.account_id, windows = excluded.windows, tokens_per_pct = excluded.tokens_per_pct,
            usd_per_pct = excluded.usd_per_pct, ci_low = excluded.ci_low, ci_high = excluded.ci_high,
            status = excluded.status, computed_at = excluded.computed_at`
    );
    let written = 0;
    const write = db.transaction(() => {
        for (const row of rows) {
            for (const week of row.weeks) {
                statement.run(
                    row.account.provider,
                    row.account.accountId,
                    row.account.accountName,
                    row.kind ?? "?",
                    row.model,
                    week.week,
                    week.windows,
                    week.tokensPerPct,
                    week.usdPerPct,
                    week.ci?.[0] ?? null,
                    week.ci?.[1] ?? null,
                    week.status,
                    now.toISOString()
                );
                written += 1;
            }
        }
    });

    write();
    return written;
}
