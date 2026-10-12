import { statSync } from "node:fs";
import {
    FILE_META_DB_PATH,
    FileMetaCache,
    PRUNE_TTL_DAYS,
    type ReconcileReport,
} from "@app/macos/lib/clones/file-meta-cache";
import { formatBytes, formatDuration, formatNumber } from "@genesiscz/utils/format";
import { logger, out } from "@genesiscz/utils/logger";

const log = logger.child({ component: "clones:cache-prune-daemon" });

/** The daemon checks a seventh of the rows a day, so every row is checked once a week. One full sweep over the
 *  976,810 rows of 2026-10-12 took 53 s at normal and 163 s at background QoS (a cold, throttled disk at 04:00 took
 *  up to 27 min); a seventh of the stored-stamp sweep is a few seconds. A gone path's row lives at most six days
 *  longer, which only costs disk: a row is a hint the scan re-checks before trusting it. */
export const DAEMON_WINDOW_RUNS = 7;

export interface CachePruneResult {
    report: ReconcileReport;
    dbPath: string;
    dbBytesBefore: number;
    dbBytesAfter: number;
}

/** The size of the cache DB with its WAL, which holds rows not yet checkpointed into the main file. */
function dbBytes(dbPath: string): number {
    const main = statSync(dbPath, { throwIfNoEntry: false })?.size ?? 0;
    const wal = statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0;
    return main + wal;
}

/** Runs `FileMetaCache.reconcile()` on the shared cache DB. Registered by
 *  `tools macos clones daemon enable` to run once a day, after the scan. */
export async function runCachePrune(dbPath: string = FILE_META_DB_PATH): Promise<CachePruneResult> {
    const dbBytesBefore = dbBytes(dbPath);
    const cache = FileMetaCache.getInstance(dbPath);
    try {
        const report = await cache.reconcile({ windowRuns: DAEMON_WINDOW_RUNS });
        cache.close();
        const dbBytesAfter = dbBytes(dbPath);
        log.info(
            { ...report, dbBytesBefore, dbBytesAfter },
            `cache reconciled: ${formatBytes(dbBytesBefore)} -> ${formatBytes(dbBytesAfter)}`
        );
        return { report, dbPath, dbBytesBefore, dbBytesAfter };
    } finally {
        cache.close();
    }
}

function windowLine(report: ReconcileReport): string {
    const { window } = report;
    if (window.runs <= 1) {
        return ", every row";
    }

    const from = window.from === "" ? "the first row" : window.from;
    const to = window.to === null ? "the last row (the next run starts at the top)" : window.to;
    return `, this run's 1/${window.runs} of the rows: after ${from} up to ${to}`;
}

function samplesLine(label: string, paths: string[], total: number): string[] {
    if (paths.length === 0) {
        return [];
    }

    const more = total > paths.length ? ` (first ${paths.length} of ${formatNumber(total)})` : "";
    return [`  ${label}${more}:`, ...paths.map((path) => `    ${path}`)];
}

/** The per-run report the daemon keeps in the run log (stdout records): what was checked, what was removed and
 *  why, the database size, the VACUUM decision and the time per phase. */
export function formatCachePruneReport(result: CachePruneResult): string[] {
    const { report } = result;
    const phases = report.phases;
    const removed = report.staleFiles + report.staleDirs + report.goneFiles + report.goneDirs;
    const reclaimed = result.dbBytesBefore - result.dbBytesAfter;

    return [
        `clones cache prune: ${result.dbPath}`,
        `rows: ${formatNumber(report.rowsBefore)} (${formatNumber(report.fileRows)} files, ${formatNumber(report.dirRows)} directories)`,
        `rows checked: ${formatNumber(report.checked)}${windowLine(report)}`,
        `rows removed: ${formatNumber(removed)}, ${formatNumber(report.rowsAfter)} left`,
        `  stale, not seen by a scan in ${PRUNE_TTL_DAYS} days: ${formatNumber(report.staleFiles)} files, ${formatNumber(report.staleDirs)} directories`,
        `  gone, the path no longer exists: ${formatNumber(report.goneFiles)} files, ${formatNumber(report.goneDirs)} directories`,
        ...samplesLine("stale files", report.samples.staleFiles, report.staleFiles),
        ...samplesLine("stale directories", report.samples.staleDirs, report.staleDirs),
        ...samplesLine("gone files", report.samples.goneFiles, report.goneFiles),
        ...samplesLine("gone directories", report.samples.goneDirs, report.goneDirs),
        `existence checks: ${formatNumber(report.listings)} directory listings, ${formatNumber(report.probes)} single-path probes`,
        `database: ${formatBytes(result.dbBytesBefore)} before, ${formatBytes(result.dbBytesAfter)} after${reclaimed > 0 ? `, ${formatBytes(reclaimed)} reclaimed` : ""}`,
        `vacuum: ${report.vacuumed ? "yes" : "no"}, ${report.vacuumReason}`,
        `phases: count ${formatDuration(phases.countMs)}, stale rows ${formatDuration(phases.ttlMs)}, sweep ${formatDuration(phases.sweepMs)} (row reads ${formatDuration(phases.readMs)}, existence checks ${formatDuration(phases.probeMs)}, deletes ${formatDuration(phases.deleteMs)}), vacuum ${formatDuration(phases.vacuumMs)}`,
        `total: ${formatDuration(report.elapsedMs)}`,
    ];
}

if (import.meta.main) {
    runCachePrune()
        .then((result) => {
            out.println(formatCachePruneReport(result).join("\n"));
            process.exitCode = 0;
        })
        .catch((err) => {
            log.error({ err }, "cache-prune-daemon failed");
            process.exitCode = 1;
        });
}
