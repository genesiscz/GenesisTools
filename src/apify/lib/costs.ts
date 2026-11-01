import { ApifyError, type ApifyRun, type PageOptions } from "@app/apify/lib/client";

export interface CostRunSource {
    runs(options: PageOptions & { startedAfter: string; startedBefore: string; desc: boolean }): Promise<{
        items: ApifyRun[];
        offset: number;
        total: number;
        count?: number;
    }>;
}

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
    if (month === 2) {
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    }

    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** A strict ISO datetime as UTC; a day the month does not have fails instead of rolling into the next month. */
export function instant(value: string): string {
    const match = DATETIME.exec(value);
    if (!match) {
        throw new ApifyError("Use an ISO datetime with a timezone, such as 2026-01-01T00:00:00+01:00.");
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
        throw new ApifyError("Invalid datetime.");
    }

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new ApifyError("Invalid datetime.");
    }

    return date.toISOString();
}

export async function summarizeCosts(options: {
    source: CostRunSource;
    since: string;
    until: string;
    pageSize: number;
    maxPages: number;
}) {
    const since = instant(options.since);
    const until = instant(options.until);
    if (since > until) {
        throw new ApifyError("Since must be at or before until.");
    }

    if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 1000) {
        throw new ApifyError("Max pages must be an integer between 1 and 1000.");
    }

    const runs: ApifyRun[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let pagesRead = 0;
    let total: number | undefined;
    let paginationChanged = false;
    let incompleteReason: string | undefined;
    let runsWithoutStartTime = 0;
    let outOfWindowRuns = 0;

    while (pagesRead < options.maxPages) {
        const page = await options.source.runs({
            limit: options.pageSize,
            offset,
            startedAfter: since,
            startedBefore: until,
            desc: false,
        });
        pagesRead++;

        if (page.offset !== offset || (page.count !== undefined && page.count !== page.items.length)) {
            throw new ApifyError("Apify returned inconsistent pagination; refusing a cost total.");
        }

        if (total !== undefined && total !== page.total) {
            paginationChanged = true;
        }

        total = page.total;
        for (const run of page.items) {
            if (seen.has(run.id)) {
                paginationChanged = true;
                continue;
            }

            seen.add(run.id);
            const started = run.startedAt === undefined ? NaN : Date.parse(run.startedAt);
            if (!Number.isFinite(started)) {
                runsWithoutStartTime++;
                continue;
            }

            if (started < Date.parse(since) || started > Date.parse(until)) {
                outOfWindowRuns++;
                continue;
            }

            runs.push(run);
        }

        offset += page.items.length;

        if (offset >= page.total) {
            break;
        }

        if (page.items.length === 0) {
            incompleteReason = "empty-page-before-total";
            break;
        }
    }

    const paginationComplete = offset >= (total ?? 0) && !paginationChanged;

    if (!paginationComplete && incompleteReason === undefined) {
        incompleteReason = paginationChanged ? "results-changed-during-pagination" : "max-pages-reached";
    }

    const costs = runs.filter((run) => run.usageTotalUsd !== undefined);
    const unfinishedRuns = runs.filter(
        (run) => !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)
    ).length;
    const byActor = new Map<
        string,
        { actorId: string; runs: number; usageTotalUsd: number; runsWithoutCost: number }
    >();
    for (const run of runs) {
        const actor = run.actId ?? "unknown";
        const item = byActor.get(actor) ?? { actorId: actor, runs: 0, usageTotalUsd: 0, runsWithoutCost: 0 };
        item.runs++;
        item.usageTotalUsd += run.usageTotalUsd ?? 0;
        item.runsWithoutCost += run.usageTotalUsd === undefined ? 1 : 0;
        byActor.set(actor, item);
    }

    return {
        window: { since, until, inclusive: true, field: "startedAt" },
        recordedUsageTotalUsd: costs.reduce((sum, run) => sum + (run.usageTotalUsd ?? 0), 0),
        basis: "Sum of run usageTotalUsd before account credits; not an invoice or account balance.",
        matchedRuns: runs.length,
        runsWithCost: costs.length,
        runsWithoutCost: runs.length - costs.length,
        unfinishedRuns,
        runsWithoutStartTime,
        outOfWindowRuns,
        paginationComplete,
        costDataComplete:
            paginationComplete &&
            costs.length === runs.length &&
            unfinishedRuns === 0 &&
            runsWithoutStartTime === 0 &&
            outOfWindowRuns === 0,
        pagesRead,
        recordsRead: offset,
        reportedTotal: total,
        nextOffset: paginationComplete ? null : offset,
        incompleteReason,
        byActor: [...byActor.values()].sort((a, b) => b.usageTotalUsd - a.usageTotalUsd),
        runs,
    };
}
