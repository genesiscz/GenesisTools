import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { formatLocalDate } from "@genesiscz/utils/date";
import { logger } from "@genesiscz/utils/logger";
import { dayOfPlainDayLog } from "@genesiscz/utils/logger/day-logs";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { PRESETS } from "./presets";
import { applyOldFileCompression, type OldFilePlan, type OldFileReport, planOldFileCompression } from "./retention";

/**
 * How many recent days stay plain. Day logs: the last 7, because `tools daemon stats --since 7d` scans up to 7 days
 * with rg, and with five of them compressed it took +87% CPU (3.5 GB to decompress on 2026-10-13, see
 * `scripts/benchmarks/compress/read-paths.ts`), over the 30% read budget. Older days are read one at a time (jev
 * sessions, a tail, an rg by hand), which costs the same or less from a `.zst`.
 */
export const DAY_LOGS_PLAIN_DAYS = 7;
/** ai-proxy transcripts: today and yesterday in UTC (a realtime session keeps writing its start day after midnight). */
export const TRANSCRIPTS_PLAIN_DAYS = 2;
/** The app's hang and stack captures (`logs/hangs/`): today and yesterday stay plain for `tools hub dev monitor`. */
export const HANGS_PLAIN_DAYS = 2;

const DAY_MS = 86_400_000;

export interface DailyTarget {
    /** Ledger caller and report label. */
    name: string;
    root: string;
    recursive: boolean;
    dayOf: (relativePath: string) => string | undefined;
    firstPlainDay: string;
}

function utcDay(time: number): string {
    return new Date(time).toISOString().slice(0, 10);
}

/** What the daily pass compresses: old day logs and old ai-proxy transcripts. */
export function dailyTargets({
    now = new Date(),
    logsDir = genesisToolsDir("logs"),
}: {
    now?: Date;
    logsDir?: string;
} = {}): DailyTarget[] {
    return [
        {
            name: "logs",
            root: logsDir,
            recursive: false,
            dayOf: dayOfPlainDayLog,
            firstPlainDay: formatLocalDate(new Date(now.getTime() - (DAY_LOGS_PLAIN_DAYS - 1) * DAY_MS)),
        },
        {
            name: "ai-proxy-transcripts",
            root: genesisToolsDir("ai-proxy", "transcripts"),
            recursive: true,
            // `<UTC day>/<session>.jsonl`; the legacy per-call `.json` files stay as they are.
            dayOf: (relative) => /^(\d{4}-\d{2}-\d{2})\/[^/]+\.jsonl$/.exec(relative)?.[1],
            firstPlainDay: utcDay(now.getTime() - (TRANSCRIPTS_PLAIN_DAYS - 1) * DAY_MS),
        },
        {
            name: "app-hangs",
            root: join(logsDir, "hangs"),
            recursive: false,
            // `hang-<local stamp>.txt` (HangWatch.swift) and `stack-<local stamp>.txt` (MainStackSampler.swift).
            dayOf: (relative) => /^(?:hang|stack)-(\d{4}-\d{2}-\d{2})-\d{6}\.txt$/.exec(relative)?.[1],
            firstPlainDay: formatLocalDate(new Date(now.getTime() - (HANGS_PLAIN_DAYS - 1) * DAY_MS)),
        },
    ];
}

export function planDailyCompression(
    options: { now?: Date; logsDir?: string } = {}
): Array<{ target: DailyTarget; plan: OldFilePlan }> {
    return dailyTargets(options).map((target) => ({
        target,
        plan: planOldFileCompression({
            root: target.root,
            dayOf: target.dayOf,
            firstPlainDay: target.firstPlainDay,
            recursive: target.recursive,
            now: options.now,
        }),
    }));
}

/** Removes the per-day claim files `.daily-compress-<day>` of earlier days (see `logger/daily-trigger.ts`). */
function sweepClaims(logsDir: string, today: string): void {
    if (!existsSync(logsDir)) {
        return;
    }

    for (const name of readdirSync(logsDir)) {
        const day = /^\.daily-compress-(\d{4}-\d{2}-\d{2})$/.exec(name)?.[1];

        if (day && day < today) {
            unlinkSync(join(logsDir, name));
        }
    }
}

/** The daily pass: compresses every old file of every target, recording each one in the ledger. */
export async function runDailyCompression(
    options: { now?: Date; logsDir?: string; retire?: (path: string) => void } = {}
): Promise<Array<{ target: DailyTarget; report: OldFileReport }>> {
    const now = options.now ?? new Date();
    const logsDir = options.logsDir ?? genesisToolsDir("logs");
    const reports: Array<{ target: DailyTarget; report: OldFileReport }> = [];

    for (const { target, plan } of planDailyCompression({ now, logsDir })) {
        const report = await applyOldFileCompression(plan, {
            caller: target.name,
            preset: PRESETS.text,
            retire: options.retire,
        });
        reports.push({ target, report });
    }

    sweepClaims(logsDir, formatLocalDate(now));
    logger.info(
        {
            targets: reports.map(({ target, report }) => ({
                name: target.name,
                compressed: report.compressed.length,
                failed: report.failed.length,
            })),
        },
        "[compress] daily pass finished"
    );
    return reports;
}
