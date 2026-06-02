import { realpathSync } from "node:fs";
import { logger } from "@app/logger";
import { loadCoverageSet } from "./coverage";
import { churnCountForFile, findRepoRoot } from "./git";
import { buildInboundImportCounts } from "./imports";
import { evaluateLifecycle } from "./lifecycle";
import { ApoptosisStateStore } from "./state";
import { scoreSurvival } from "./survival";
import type { FileReport, ScanReport } from "./types";
import { listSourceFiles } from "./walk";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScanOptions {
    dir: string;
    churnDays: number;
    graceDays: number;
    exts: string[];
    ignore: string[];
    coveragePath: string | undefined;
    useState: boolean;
    /** Injected current time in epoch ms. */
    now: number;
}

/** Normalize a dir to its realpath so file keys agree with git's toplevel
 *  (which always returns the realpath, e.g. /private/var on macOS). */
function canonicalDir(dir: string): string {
    try {
        return realpathSync(dir);
    } catch {
        return dir;
    }
}

export async function runScan(opts: ScanOptions): Promise<ScanReport> {
    const dir = canonicalDir(opts.dir);
    const graceMs = opts.graceDays * DAY_MS;
    const files = listSourceFiles(dir, opts.exts, opts.ignore);
    logger.debug(`apoptosis: scanning ${files.length} files under ${dir}`);

    const repoRoot = (await findRepoRoot(dir)) ?? dir;
    const inbound = buildInboundImportCounts(files);
    const coverage = loadCoverageSet(opts.coveragePath);

    const store = new ApoptosisStateStore();
    const marks = opts.useState ? await store.getMarks(dir) : {};

    const reports: FileReport[] = [];
    let candidates = 0;
    let rescued = 0;
    let ready = 0;

    for (const file of files) {
        const churnCount = await churnCountForFile(file, opts.churnDays, repoRoot);
        const survival = scoreSurvival({
            churnCount,
            inboundImports: inbound.get(file) ?? 0,
            hasCoverage: coverage.has(file),
        });

        const existing = marks[file]?.firstMarked ?? null;
        const status = evaluateLifecycle({
            isCandidate: survival.isCandidate,
            firstMarked: existing,
            now: opts.now,
            graceMs,
        });

        let firstMarked: string | null = existing;
        if (status === "dying" && !existing) {
            firstMarked = new Date(opts.now).toISOString();
            if (opts.useState) {
                await store.mark(dir, file, firstMarked);
            }
        } else if (status === "rescued") {
            firstMarked = null;
            if (opts.useState) {
                await store.clear(dir, file);
            }
        }

        if (survival.isCandidate) {
            candidates++;
        }

        if (status === "rescued") {
            rescued++;
        }

        if (status === "dead") {
            ready++;
        }

        const daysMarked = firstMarked ? Math.floor((opts.now - Date.parse(firstMarked)) / DAY_MS) : null;

        let daysLeft: number | null = null;
        if (status === "dying" && firstMarked) {
            daysLeft = Math.max(0, opts.graceDays - (daysMarked ?? 0));
        } else if (status === "dead") {
            daysLeft = 0;
        }

        reports.push({ path: file, survival, status, firstMarked, daysMarked, daysLeft });
    }

    return {
        dir,
        scannedAt: new Date(opts.now).toISOString(),
        churnDays: opts.churnDays,
        graceDays: opts.graceDays,
        counts: { scanned: files.length, candidates, rescued, ready },
        files: reports,
    };
}
