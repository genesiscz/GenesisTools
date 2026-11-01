import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
    type MaintainOptions,
    type MaintenanceReport,
    maintainObjectStore,
    summaryLine,
} from "@genesiscz/utils/agents/objects/maintain";
import { formatLocalDate } from "@genesiscz/utils/date";
import { carrySavedEntries } from "@genesiscz/utils/fs/identity-cache";
import { logger } from "@genesiscz/utils/logger";
import { dayLogDigestsDir, dayOfPlainDayLog } from "@genesiscz/utils/logger/day-logs";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { PRESETS } from "./presets";
import {
    applyOldFileCompression,
    type OldFilePlan,
    type OldFileReport,
    planOldFileCompression,
    type ReplacedFile,
} from "./retention";

/**
 * How many recent days of the day files (`<day>.log`, `<day>-profiling.log`, `<day>-failures.jsonl`) stay plain: today
 * and yesterday. No writer appends to an older day (each picks the file by the current local date, and the logger
 * closes yesterday's file at midnight), and the pass runs just after midnight, when yesterday was written a minute ago
 * and the 2-hour quiet window skips it anyway. `tools daemon stats --since 7d` reads a week within the 30% read budget
 * because it keeps the health lines of finished days (`ripgrepFilesCached`, `scripts/benchmarks/compress/read-paths.ts`);
 * the other readers take one day at a time, which costs the same or less from a `.zst`. The app launcher reads today's
 * and yesterday's failures as plain files (LauncherFailures.swift `recorded`).
 */
export const DAY_LOGS_PLAIN_DAYS = 2;
/** ai-proxy transcripts: today and yesterday in UTC (a realtime session keeps writing its start day after midnight). */
export const TRANSCRIPTS_PLAIN_DAYS = 2;
/** The app's hang and stack captures (`logs/hangs/`): today and yesterday stay plain for `tools hub dev monitor`. */
export const HANGS_PLAIN_DAYS = 2;

const DAY_MS = 86_400_000;

/** The local day `days` calendar days before `now` (a calendar step, so a daylight-saving day counts as one day). */
function localDaysBefore(now: Date, days: number): string {
    const day = new Date(now);
    day.setDate(day.getDate() - days);
    return formatLocalDate(day);
}

export interface DailyTarget {
    /** Ledger caller and report label. */
    name: string;
    root: string;
    recursive: boolean;
    dayOf: (relativePath: string) => string | undefined;
    firstPlainDay: string;
    /** What follows a file's replacement by its `.zst`: the day logs move the lines searches kept for it. */
    onReplaced?: (replaced: ReplacedFile) => void;
}

function utcDay(time: number): string {
    return new Date(time).toISOString().slice(0, 10);
}

/** What the daily pass compresses: old day files (day logs, profiling, failures), ai-proxy transcripts, hangs. */
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
            // The `.zst` holds the same bytes (verified), so what `ripgrepFilesCached` kept for the plain day serves it.
            onReplaced: ({ plain, identity, compressed }) =>
                carrySavedEntries({
                    dir: dayLogDigestsDir(logsDir),
                    from: plain,
                    fromIdentity: identity,
                    to: compressed,
                }),
            firstPlainDay: localDaysBefore(now, DAY_LOGS_PLAIN_DAYS - 1),
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
            firstPlainDay: localDaysBefore(now, HANGS_PLAIN_DAYS - 1),
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

/** The lock one daily pass holds over its logs folder for its whole run (`runDailyCompression`). */
export function dailyPassLockPath(logsDir: string): string {
    return join(logsDir, ".daily-compress.lock");
}

export type DailyPassReports = Array<{ target: DailyTarget; report: OldFileReport }>;

export interface DailyPassReport {
    compression: DailyPassReports;
    /** The `agents-objects` step; null when it failed (the error is in the day log). */
    objectStore: MaintenanceReport | null;
}

/**
 * The daily pass's `agents-objects` step: packs the agents change-log object store and drops what no change-log row
 * of the retention window names (`maintainObjectStore`). It writes the pass's one before/after line for the store.
 * Never throws, so a failure here leaves the logs' compression standing.
 */
export async function runObjectStoreStep(options: MaintainOptions = {}): Promise<MaintenanceReport | null> {
    try {
        const report = await maintainObjectStore(options);
        logger.info(
            { before: report.before, after: report.after, dropped: report.dropped, restored: report.restored },
            `[compress] daily pass, agents-objects: ${summaryLine(report)}`
        );
        return report;
    } catch (err) {
        logger.error({ err }, "[compress] daily pass, agents-objects failed; it removes nothing before it is verified");
        return null;
    }
}

/**
 * The daily pass: compresses every old file of every target, recording each one in the ledger, then runs the
 * `agents-objects` step. Only one pass runs per logs folder: `tools compress daily` opens the logger, which may start
 * the detached pass of the day beside it, and two passes over one file once deleted its only copy (each retired what
 * the other had compressed). The second caller returns `null` at once and leaves the work to the pass that holds the
 * lock; a lock whose holder died is taken over.
 */
export async function runDailyCompression(
    options: {
        now?: Date;
        logsDir?: string;
        retire?: (path: string) => void;
        releaseGraceMs?: number;
        objects?: MaintainOptions;
    } = {}
): Promise<DailyPassReport | null> {
    const now = options.now ?? new Date();
    const logsDir = options.logsDir ?? genesisToolsDir("logs");
    const lock = dailyPassLockPath(logsDir);
    let held = false;

    try {
        return await withFileLock(
            lock,
            async () => {
                held = true;
                return await compressDailyTargets({ ...options, now, logsDir });
            },
            0
        );
    } catch (err) {
        if (err instanceof LockTimeoutError && !held) {
            logger.info({ lock }, "[compress] another daily pass holds the lock; this one does nothing");
            return null;
        }

        throw err;
    }
}

async function compressDailyTargets(options: {
    now: Date;
    logsDir: string;
    retire?: (path: string) => void;
    releaseGraceMs?: number;
    objects?: MaintainOptions;
}): Promise<DailyPassReport> {
    const { now, logsDir } = options;
    const reports: DailyPassReports = [];

    for (const { target, plan } of planDailyCompression({ now, logsDir })) {
        const report = await applyOldFileCompression(plan, {
            caller: target.name,
            preset: PRESETS.text,
            retire: options.retire,
            releaseGraceMs: options.releaseGraceMs,
            onReplaced: target.onReplaced,
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
    const objectStore = await runObjectStoreStep({ now, ...options.objects });
    return { compression: reports, objectStore };
}
