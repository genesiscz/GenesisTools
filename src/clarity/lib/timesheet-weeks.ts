import type { ClarityMapping } from "@app/clarity/config";
import type { ClarityApi } from "@genesiscz/utils/clarity";
import { isDateInHalfOpenRange } from "@genesiscz/utils/date";
import { logger } from "@genesiscz/utils/logger";

export interface TimesheetWeek {
    /**
     * Absent on future periods Clarity has not opened a timesheet for. Every call that sends this
     * to the API must narrow it first; `timesheetId=undefined` answers `API-1006 invalidAttrValue`.
     */
    timesheetId: number | undefined;
    timePeriodId: number;
    startDate: string;
    finishDate: string;
    totalHours: number;
    status: string;
    entryCount?: number;
}

/**
 * Resolve an explicit `--timesheet` argument. A flag that was passed at all must name a real
 * timesheet: `--timesheet ""` is truthy-false, so a bare truthiness test lets a blank value fall
 * through to the default date and quietly act on the wrong month.
 */
export function parseTimesheetArg(raw: string | undefined): { supplied: boolean; id?: number } {
    if (raw === undefined) {
        return { supplied: false };
    }

    const id = Number(raw.trim());

    if (!Number.isSafeInteger(id) || id <= 0) {
        return { supplied: true };
    }

    return { supplied: true, id };
}

/** A week Clarity has actually opened a timesheet for, so its id is safe to send to the API. */
export type IdentifiedTimesheetWeek = TimesheetWeek & { timesheetId: number };

export function hasTimesheetId(week: TimesheetWeek): week is IdentifiedTimesheetWeek {
    return week.timesheetId !== undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: Clarity carousel entries have inconsistent shapes
type CarouselEntry = any;

interface NestedTimesheet {
    _results: Array<{
        timesheet_id: number;
        total: string;
        prstatus: { _results: Array<{ displayValue: string }> };
    }>;
}

/**
 * Parse a single carousel entry into a TimesheetWeek.
 * Handles two response shapes: flat (with filter) and nested (tpTimesheet._results[0]).
 */
function parseCarouselEntry(entry: CarouselEntry, entryCountMap: Map<number, number>): TimesheetWeek {
    const raw = entry as Record<string, unknown>;
    const nested = raw.tpTimesheet as NestedTimesheet | undefined;
    const tp = nested?._results?.[0];

    const timesheetId = entry.timesheet_id ?? tp?.timesheet_id;
    const totalRaw: unknown = entry.total ?? tp?.total;
    const total =
        typeof totalRaw === "string"
            ? Number.parseFloat(totalRaw.replace(",", "."))
            : typeof totalRaw === "number"
              ? totalRaw
              : 0;
    const status = entry.prstatus?.displayValue ?? tp?.prstatus?._results?.[0]?.displayValue ?? "unknown";

    return {
        timesheetId,
        timePeriodId: entry.id,
        startDate: entry.start_date.split("T")[0],
        finishDate: entry.finish_date.split("T")[0],
        totalHours: total,
        status,
        entryCount: entryCountMap.get(timesheetId),
    };
}

/**
 * Pick the period id the carousel walk starts from. Without one, `getTimesheetApp` returns only the
 * window around today and any month further back is unreachable, so a fill for an older month found
 * no periods and silently booked nothing. A mapping's cached period is used when present; otherwise
 * the server is asked for its current one.
 */
export async function resolveCarouselSeed({
    api,
    cachedTimePeriodId,
}: {
    api: { getTimesheetApp: (timePeriodId?: number) => Promise<TimesheetAppLike> };
    cachedTimePeriodId: number | undefined;
}): Promise<number | undefined> {
    if (cachedTimePeriodId !== undefined) {
        return cachedTimePeriodId;
    }

    const app = await api.getTimesheetApp();

    const carousel = app.tscarousel?._results ?? [];
    // The first carousel entry is the OLDEST in the window; the active one is what "current" means.
    const active = carousel.find((entry) => entry.is_active) ?? carousel[Math.floor(carousel.length / 2)];

    return app.timesheets?._results?.[0]?.timePeriodId ?? active?.id;
}

interface TimesheetAppLike {
    tscarousel?: { _results?: Array<{ id?: number; is_active?: boolean }> };
    timesheets?: { _results?: Array<{ timePeriodId?: number }> };
}

/**
 * Walk the carousel to the period covering a date. One window spans about nine weeks, so a month a
 * quarter back needs several hops; a single `findTimesheetForDate` call only ever searched the
 * first window and quietly returned nothing for anything older.
 */
export async function navigateToPeriodForDate({
    api,
    seedTimePeriodId,
    date,
    maxHops = 12,
}: {
    api: { getTimesheetApp: (timePeriodId?: number) => Promise<CarouselWindowLike> };
    seedTimePeriodId: number;
    date: string;
    maxHops?: number;
}): Promise<number | undefined> {
    let centre = seedTimePeriodId;
    const visited = new Set<number>();

    for (let hop = 0; hop < maxHops; hop++) {
        if (visited.has(centre)) {
            return undefined;
        }

        visited.add(centre);
        const entries = (await api.getTimesheetApp(centre)).tscarousel?._results ?? [];

        if (entries.length === 0) {
            return undefined;
        }

        const covering = entries.find((entry) =>
            isDateInHalfOpenRange(date, entry.start_date ?? "", entry.finish_date ?? "")
        );

        if (covering?.id !== undefined) {
            return covering.id;
        }

        const sorted = [...entries].sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const next = date < (first.start_date ?? "").split("T")[0] ? first.id : last.id;

        if (next === undefined) {
            return undefined;
        }

        centre = next;
    }

    return undefined;
}

interface CarouselWindowLike {
    tscarousel?: { _results?: Array<{ id?: number; start_date?: string; finish_date?: string }> };
}

export async function getTimesheetWeeks(
    api: ClarityApi,
    mappings: ClarityMapping[],
    month?: number,
    year?: number
): Promise<{ weeks: TimesheetWeek[]; userId?: number }> {
    // Try to find a valid timePeriodId to seed the carousel.
    // When a specific month/year is requested, try to navigate to a period covering that month
    // so the carousel window is anchored correctly.
    const seedTimePeriodId = await resolveCarouselSeed({
        api,
        cachedTimePeriodId: await findValidTimePeriodId(api, mappings),
    });
    let timePeriodId = seedTimePeriodId;

    if (month !== undefined && year !== undefined && seedTimePeriodId !== undefined) {
        const targetDate = `${year}-${String(month).padStart(2, "0")}-15`;

        try {
            const reached = await navigateToPeriodForDate({ api, seedTimePeriodId, date: targetDate });

            if (reached !== undefined) {
                timePeriodId = reached;
            }
        } catch (err) {
            logger.debug(`[clarity] carousel navigation to ${targetDate} failed, using the seed period: ${err}`);
        }
    }

    const app = await api.getTimesheetApp(timePeriodId);
    const userId = app.resource?._results?.[0]?.user_id;
    let carousel = app.tscarousel?._results;

    // If carousel is empty, try extracting timePeriodId from the timesheets section
    if (!carousel?.length) {
        const ts = app.timesheets?._results?.[0];

        if (ts?.timePeriodId) {
            const retry = await api.getTimesheetApp(ts.timePeriodId);
            carousel = retry.tscarousel?._results;
        }
    }

    if (!carousel?.length) {
        return { weeks: [], userId };
    }

    // Build a map of timesheetId → numberOfEntries from the timesheets section (current period)
    const entryCountMap = new Map<number, number>();

    for (const ts of app.timesheets?._results ?? []) {
        entryCountMap.set(ts._internalId, ts.numberOfEntries ?? 0);
    }

    let weeks: TimesheetWeek[] = carousel.map((entry: CarouselEntry) => parseCarouselEntry(entry, entryCountMap));

    // If a specific month is requested and the carousel doesn't cover it fully,
    // fetch additional carousel pages by navigating to earlier/later timePeriodIds
    if (month !== undefined && year !== undefined) {
        const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

        // Check if we need earlier weeks
        const firstStart = weeks[0]?.startDate;

        if (firstStart && firstStart > monthStart) {
            const firstId = weeks[0].timePeriodId;

            try {
                const earlier = await api.getTimesheetApp(firstId - 4);

                for (const entry of earlier.tscarousel?._results ?? []) {
                    const sd = entry.start_date.split("T")[0];

                    if (!weeks.some((w) => w.timePeriodId === entry.id) && sd < firstStart) {
                        weeks.unshift(parseCarouselEntry(entry, entryCountMap));
                    }
                }

                weeks.sort((a, b) => a.startDate.localeCompare(b.startDate));
            } catch (err) {
                logger.debug(`[clarity] carousel edge hop failed, returning the window we have: ${err}`);
            }
        }

        // Check if we need later weeks (last finishDate doesn't cover month end)
        const lastFinish = weeks[weeks.length - 1]?.finishDate;

        if (lastFinish && lastFinish <= monthEnd) {
            const lastId = weeks[weeks.length - 1].timePeriodId;
            try {
                const later = await api.getTimesheetApp(lastId + 1);

                for (const entry of later.tscarousel?._results ?? []) {
                    const sd = entry.start_date.split("T")[0];

                    if (!weeks.some((w) => w.timePeriodId === entry.id) && sd >= lastFinish) {
                        weeks.push(parseCarouselEntry(entry, entryCountMap));
                    }
                }

                weeks.sort((a, b) => a.startDate.localeCompare(b.startDate));
            } catch (err) {
                logger.debug(`[clarity] carousel edge hop failed, returning the window we have: ${err}`);
            }
        }

        weeks = weeks.filter((w) => w.startDate <= monthEnd && w.finishDate > monthStart);
    }

    // Fetch entry counts for weeks that don't have them yet (not in current period's timesheets section)
    const needsCount = weeks.filter(
        (w): w is IdentifiedTimesheetWeek => w.entryCount === undefined && hasTimesheetId(w)
    );

    if (needsCount.length > 0) {
        const results = await Promise.allSettled(
            needsCount.map(async (w) => {
                const ts = await api.getTimesheet(w.timesheetId);
                const record = ts.timesheets._results[0];
                return { timesheetId: w.timesheetId, count: record?.numberOfEntries ?? 0 };
            })
        );

        for (const result of results) {
            if (result.status === "fulfilled") {
                const week = weeks.find((w) => w.timesheetId === result.value.timesheetId);

                if (week) {
                    week.entryCount = result.value.count;
                }
            }
        }
    }

    return { weeks, userId };
}

/** Check if an error indicates a "not found" condition (vs auth/transport failure) */
function isNotFoundError(err: unknown): boolean {
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        return msg.includes("not found") || msg.includes("404") || msg.includes("no results");
    }

    return false;
}

async function findValidTimePeriodId(api: ClarityApi, mappings: ClarityMapping[]): Promise<number | undefined> {
    // Strategy 1: Use an existing mapping's clarityTimesheetId to get a timePeriodId
    for (const mapping of mappings) {
        if (!mapping.clarityTimesheetId) {
            continue;
        }

        try {
            const ts = await api.getTimesheet(mapping.clarityTimesheetId);
            const record = ts.timesheets._results[0];

            if (record?.timePeriodId) {
                return record.timePeriodId;
            }
        } catch (err) {
            // Only continue to next mapping if timesheet was not found;
            // rethrow auth/permission/transport errors so they surface to the caller
            if (!isNotFoundError(err)) {
                throw err;
            }
        }
    }

    // Strategy 2: Fall back to undefined (no filter = current period)
    return undefined;
}

/**
 * Pick the period covering a date. Clarity periods share a boundary date, so the range is
 * half-open: the finish date belongs to the next period, not this one. Future periods carry no
 * timesheet id yet and are skipped, because the API rejects `timesheetId=undefined`.
 */
export function findWeekForDate(weeks: TimesheetWeek[], date: string): IdentifiedTimesheetWeek | undefined {
    return weeks.find(
        (week): week is IdentifiedTimesheetWeek =>
            hasTimesheetId(week) && isDateInHalfOpenRange(date, week.startDate, week.finishDate)
    );
}

/**
 * Select periods for a `--date` argument. A full `YYYY-MM-DD` picks the single covering period;
 * a `YYYY-MM` picks every period that reaches into that month.
 */
export function selectWeeksForDateArg(weeks: TimesheetWeek[], dateArg: string): TimesheetWeek[] {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
        const week = findWeekForDate(weeks, dateArg);

        return week ? [week] : [];
    }

    if (!/^\d{4}-\d{2}$/.test(dateArg)) {
        throw new Error(`Invalid --date '${dateArg}': expected YYYY-MM-DD or YYYY-MM`);
    }

    const [year, month] = dateArg.split("-").map(Number);
    const monthStart = `${dateArg}-01`;
    const monthEnd = `${dateArg}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

    return weeks.filter((week) => week.timesheetId && week.startDate <= monthEnd && week.finishDate > monthStart);
}

/**
 * Order the periods to try when looking for the Clarity task catalogue. A month's own timesheet
 * can exist with no task rows yet, so fall back to the newest other period that does have them.
 */
export function taskSourceWeekOrder(weeks: TimesheetWeek[], preferred: TimesheetWeek | undefined): TimesheetWeek[] {
    const rest = weeks
        .filter((week) => week.timesheetId && week.timesheetId !== preferred?.timesheetId)
        .sort((a, b) => b.startDate.localeCompare(a.startDate));

    return preferred?.timesheetId ? [preferred, ...rest] : rest;
}
