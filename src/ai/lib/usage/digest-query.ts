import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ledgerTotals, readWorkerCostRows, type WorkerCostRow } from "@app/ai-spend/lib/workers/ledger";
import { readDigestConfig } from "@app/hub/lib/digest";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { UsageAlertsStore } from "@genesiscz/utils/ai/usage/alerts/log";
import type { StoredAlert } from "@genesiscz/utils/ai/usage/alerts/types";
import { type AttributedEvent, loadAttributedSpend } from "@genesiscz/utils/ai/usage/attribution";
import {
    type AccountKey,
    refuseHarness,
    resolveTimeZone,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
} from "@genesiscz/utils/ai/usage/contract";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { type DailyRow, dailyRowsOf, dayBounds, UsageDailyStore } from "@genesiscz/utils/ai/usage/rollup/daily";
import {
    type DigestOutlookRow,
    type DigestPeriod,
    type DigestWorkers,
    digestAlerts,
    digestMarkdown,
    digestSpend,
    digestWindows,
    USAGE_DIGEST_SCHEMA,
    type UsageDigest,
} from "@genesiscz/utils/ai/usage/rollup/digest";
import { zonedDay } from "@genesiscz/utils/ai/usage/spend/reports/dates";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { snapshotsFromCache, usageAccountKeys } from "@genesiscz/utils/ai/usage-poll/limits-now";
import { usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import { readLimitSeries } from "@genesiscz/utils/ai/usage-poll/series";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { aiSessionsCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

export interface DigestOptions {
    day?: string | boolean;
    week?: string | boolean;
    tz?: string;
    json?: boolean;
    md?: boolean;
    write?: boolean;
    harness?: string[] | boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function nextDay(day: string, tz: string): string {
    return zonedDay(new Date(dayBounds(day, tz).start + 36 * 3_600_000).toISOString(), tz);
}

function previousDay(day: string, tz: string): string {
    return zonedDay(new Date(dayBounds(day, tz).start - 3_600_000).toISOString(), tz);
}

/** The local days of the asked period: `--day [date]` (default yesterday) or `--week [date]` (default last week). */
export function digestDays(
    opts: Pick<DigestOptions, "day" | "week">,
    now: Date,
    tz: string
): { period: DigestPeriod; days: string[] } {
    const today = zonedDay(now.toISOString(), tz);
    const given = typeof opts.week === "string" ? opts.week : typeof opts.day === "string" ? opts.day : undefined;

    if (given !== undefined && !DAY.test(given)) {
        throw new UsageQueryError("bad-value", `"${given}" is not a date YYYY-MM-DD.`, { given });
    }

    if (opts.week === undefined || opts.week === false) {
        return { period: "day", days: [given ?? previousDay(today, tz)] };
    }

    let day = given ?? today;

    // Back to the Monday of that week; without a date, the week before the current one. The weekday is the civil
    // date's own (its UTC noon), never an instant of the zone: in UTC+14 a local noon is still the day before in UTC.
    while (new Date(`${day}T12:00:00.000Z`).getUTCDay() !== 1) {
        day = previousDay(day, tz);
    }

    if (given === undefined) {
        for (let i = 0; i < 7; i++) {
            day = previousDay(day, tz);
        }
    }

    const days = [day];

    while (days.length < 7) {
        days.push(nextDay(days[days.length - 1], tz));
    }

    return { period: "week", days };
}

function workersOf(rows: readonly WorkerCostRow[], from: number, to: number): DigestWorkers | null {
    const inside = rows.filter((row) => {
        const at = Date.parse(row.ts);
        return at >= from && at < to;
    });

    if (inside.length === 0) {
        return null;
    }

    const backends = [...new Set(inside.map((row) => row.backend))];

    return {
        byBackend: backends.map((backend) => {
            const mine = inside.filter((row) => row.backend === backend);
            const totals = ledgerTotals(mine);
            return {
                backend,
                turns: totals.turns,
                apiEquivalentUsd: totals.apiEquivalentUsd,
                failedTurns: mine.filter((row) => row.outcome === "failed" || row.outcome === "interrupted").length,
            };
        }),
    };
}

export interface DigestDeps {
    now?: Date;
    loadEvents?: typeof loadAttributedSpend;
    workerRows?: () => WorkerCostRow[];
}

/**
 * `tools ai usage digest` (design 2026-11-01, step U10, proposal 16): one day or one week of every account's
 * windows (from the daily rollup, computed from the readings where they are still kept), spend by provider and model
 * with the costliest sessions, worker cost, the alerts that fired, and the windows forecast to run out. It writes
 * nothing unless `--write` asks for the vault note.
 */
export async function queryDigest(opts: DigestOptions, deps: DigestDeps = {}): Promise<UsageEnvelope<UsageDigest>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const tz = resolveTimeZone(opts.tz);
    const { period, days } = digestDays(opts, now, tz);
    const from = dayBounds(days[0], tz).start;
    const to = dayBounds(days[days.length - 1], tz).end;
    const store = await AiConfigStore.readOnly();
    const providerIds = usagePlugins().map((entry) => entry.plugin.id);
    const directory = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: false });
    const keyOf = (provider: string, name: string): AccountKey =>
        directory.find((key) => key.provider === provider && key.accountName === name) ?? {
            provider,
            accountId: name,
            accountName: name,
        };
    // A diagnostic read: no schema, no migration, no file; only `--write` writes, and only its note.
    const db = UsageLimitsDb.readOnlyOrEmpty();
    let rows: DailyRow[] = [];
    let alerts: StoredAlert[] = [];
    let outlook: DigestOutlookRow[] = [];
    const warnings: UsageWarning[] = [];

    try {
        const series = db.getSeries({
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
            agg: "raw",
            step: 0,
        });
        const fresh = dailyRowsOf({
            series,
            tz,
            runs: new PollRunsStore(db.connection()).runsBetween({ from: new Date(from), to: new Date(to) }),
            accountIdOf: (entry) => keyOf(entry.provider, entry.account).accountId,
            days: new Set(days),
        });
        const freshKeys = new Set(
            fresh.map((row) => `${row.provider}\u0000${row.accountName}\u0000${row.bucket}\u0000${row.day}`)
        );
        const kept = new UsageDailyStore(db.connection())
            .between({ from: days[0], to: days[days.length - 1] })
            .filter(
                (row) => !freshKeys.has(`${row.provider}\u0000${row.accountName}\u0000${row.bucket}\u0000${row.day}`)
            );
        // A stored day was cut at the daemon's midnight; its peak and resets cannot move to another zone's day.
        const stored = kept.filter((row) => row.tz === tz);
        const otherZones = [...new Set(kept.filter((row) => row.tz !== tz).map((row) => row.tz))];

        if (otherZones.length > 0) {
            warnings.push({
                code: "rollup-other-tz",
                message: `Days whose readings are pruned were kept in ${otherZones.join(", ")}, not ${tz}; they are left out. Ask with --tz ${otherZones[0]}.`,
            });
        }

        rows = [...fresh, ...stored];

        const current = snapshotsFromCache(await readSnapshotsCache());
        const outlookSeries = readLimitSeries(
            {
                from: new Date(now.getTime() - 86_400_000).toISOString(),
                to: now.toISOString(),
                agg: "last",
                forecastAt: now,
            },
            { db, directory, current }
        );
        outlook = outlookSeries.series
            .filter((item) => item.forecast?.beforeReset)
            .map((item) => ({
                account: { provider: item.provider, accountId: item.accountId, accountName: item.accountName },
                label: item.label,
                utilization: item.forecast?.utilization ?? 0,
                exhaustAt: item.forecast?.exhaustAt ?? null,
                resetsAt: item.forecast?.resetsAt ?? null,
            }));
    } finally {
        db.close();
    }

    const readOnly = openHistoryReadOnly();

    try {
        alerts = readOnly ? new UsageAlertsStore(readOnly).list({ from: new Date(from), to: new Date(to) }) : [];
    } finally {
        readOnly?.close();
    }

    const events: AttributedEvent[] = (
        await (deps.loadEvents ?? loadAttributedSpend)({ from: new Date(from), now, directory })
    ).filter((event) => event.at >= from && event.at < to);

    if (rows.length === 0) {
        warnings.push({
            code: "no-readings",
            message: `No limit readings for ${days[0]}${days.length > 1 ? ` to ${days.at(-1)}` : ""}.`,
        });
    }

    const digest: UsageDigest = {
        period,
        days,
        windows: digestWindows(rows, (row) => keyOf(row.provider, row.accountName)),
        alerts: digestAlerts(alerts),
        spend: digestSpend(events, (sessionId) => aiSessionsCommand("report", sessionId)),
        outlook,
        workers: workersOf((deps.workerRows ?? readWorkerCostRows)(), from, to),
    };

    logger.debug({ period, days: days.length, rows: rows.length, events: events.length }, "[ai-usage] digest");

    return usageEnvelope({
        ...USAGE_DIGEST_SCHEMA,
        now,
        window: { from: new Date(from), to: new Date(to), tz, label: `${period} ${days[0]}` },
        accounts: digest.windows.map((window) => window.account),
        data: digest,
        warnings,
    });
}

export function digestTitle(digest: UsageDigest): string {
    return digest.period === "week" ? `Usage week of ${digest.days[0]}` : `Usage ${digest.days[0]}`;
}

/** Writes the note into the hub digest folder (`tools hub digest --folder`); returns its path. */
export async function writeDigestNote(digest: UsageDigest): Promise<string> {
    const { folder } = await readDigestConfig();

    if (!folder) {
        throw new UsageQueryError(
            "bad-value",
            `No digest folder is set. Set one with ${toolCommand("hub digest config", "--folder")} <path>.`
        );
    }

    mkdirSync(folder, { recursive: true });
    const name = digest.period === "week" ? `${digest.days[0]} Usage week.md` : `${digest.days[0]} Usage digest.md`;
    const path = join(folder, name);
    atomicWriteFileSync(path, digestMarkdown(digest, digestTitle(digest)));
    return path;
}
