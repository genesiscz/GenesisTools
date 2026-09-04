import type { TimesheetAppResponse, TimesheetResponse } from "@genesiscz/utils/clarity";
import { isDateInHalfOpenRange } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
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

/** The two Clarity reads the week walk needs, so callers and tests need no concrete api class. */
export interface TimesheetWeekReader {
    getTimesheetApp(timePeriodId?: number): Promise<TimesheetAppResponse>;
    getTimesheet(timesheetId: number): Promise<TimesheetResponse>;
}

export type TimesheetRecord = TimesheetResponse["timesheets"]["_results"][number];

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

interface NestedTimesheet {
    _results: Array<{
        timesheet_id: number;
        total: string;
        prstatus: { _results: Array<{ displayValue: string }> };
    }>;
}

interface CarouselEntry {
    id?: number;
    start_date?: string;
    finish_date?: string;
    timesheet_id?: number;
    total?: string | number;
    is_active?: boolean;
    prstatus?: { displayValue?: string };
    tpTimesheet?: NestedTimesheet;
}

/** A carousel entry that carries everything a week needs, so parsing it cannot throw. */
type DatedCarouselEntry = CarouselEntry & { id: number; start_date: string; finish_date: string };

function isDated(entry: CarouselEntry | undefined): entry is DatedCarouselEntry {
    return Boolean(entry?.id !== undefined && entry?.start_date && entry?.finish_date);
}

/**
 * Parse a single carousel entry into a TimesheetWeek.
 * Handles two response shapes: flat (with filter) and nested (tpTimesheet._results[0]).
 */
function parseCarouselEntry(entry: DatedCarouselEntry, entryCountMap: Map<number, number>): TimesheetWeek {
    const tp = entry.tpTimesheet?._results?.[0];

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
        entryCount: timesheetId === undefined ? undefined : entryCountMap.get(timesheetId),
    };
}

function parseCarouselEntries(entries: CarouselEntry[], entryCountMap: Map<number, number>): TimesheetWeek[] {
    const weeks: TimesheetWeek[] = [];

    for (const entry of entries) {
        if (!isDated(entry)) {
            logger.debug(`[clarity] carousel entry without an id or dates skipped: ${SafeJSON.stringify(entry)}`);
            continue;
        }

        weeks.push(parseCarouselEntry(entry, entryCountMap));
    }

    return weeks;
}

/**
 * The period id the carousel walk starts from: whichever period the server calls current. An older
 * month is then reached by walking, not by trusting a stored id that may name a stale window.
 */
export async function resolveCarouselSeed({
    api,
}: {
    api: { getTimesheetApp: (timePeriodId?: number) => Promise<TimesheetAppLike> };
}): Promise<number | undefined> {
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
        const windowStart = (first.start_date ?? "").split("T")[0];
        const windowFinish = (last.finish_date ?? "").split("T")[0];

        // The date sits inside this window's span yet no entry claims it, so the carousel has a
        // gap there. Walking on would leave the target behind and burn every remaining hop.
        if (date >= windowStart && date < windowFinish) {
            logger.debug(`[clarity] carousel gap: ${date} lies inside ${windowStart}..${windowFinish} uncovered`);
            return undefined;
        }

        const next = date < windowStart ? first.id : last.id;

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

function monthBounds(year: number, month: number): { monthStart: string; monthEnd: string } {
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const lastDay = new Date(year, month, 0).getDate();

    return { monthStart: `${prefix}-01`, monthEnd: `${prefix}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * The periods that reach into a month. A period's finish date is exclusive, so one ending on the
 * first of the month belongs to the month before it.
 */
export function weeksTouchingMonth<T extends { startDate: string; finishDate: string }>(
    weeks: T[],
    year: number,
    month: number
): T[] {
    const { monthStart, monthEnd } = monthBounds(year, month);

    return weeks.filter((week) => week.startDate <= monthEnd && week.finishDate > monthStart);
}

function coversDate(weeks: TimesheetWeek[], date: string): boolean {
    return weeks.some((week) => isDateInHalfOpenRange(date, week.startDate, week.finishDate));
}

function nearestPeriodId(weeks: TimesheetWeek[], date: string): number | undefined {
    let best: TimesheetWeek | undefined;

    for (const week of weeks) {
        if (
            !best ||
            Math.abs(Date.parse(week.startDate) - Date.parse(date)) <
                Math.abs(Date.parse(best.startDate) - Date.parse(date))
        ) {
            best = week;
        }
    }

    return best?.timePeriodId;
}

/**
 * One carousel window spans about nine weeks, which usually covers a month but not always. Reach
 * the ends of the month through the same walk the rest of the tool uses, rather than guessing a
 * period-id offset: ids are only consecutive by convention, and an offset cannot report a miss.
 */
async function widenToCoverMonth({
    api,
    weeks,
    entryCountMap,
    monthStart,
    monthEnd,
    seedTimePeriodId,
}: {
    api: TimesheetWeekReader;
    weeks: TimesheetWeek[];
    entryCountMap: Map<number, number>;
    monthStart: string;
    monthEnd: string;
    seedTimePeriodId?: number;
}): Promise<TimesheetWeek[]> {
    const merged = [...weeks];

    for (const target of [monthStart, monthEnd]) {
        if (coversDate(merged, target)) {
            continue;
        }

        const seed = nearestPeriodId(merged, target) ?? seedTimePeriodId;

        if (seed === undefined) {
            continue;
        }

        try {
            const reached = await navigateToPeriodForDate({ api, seedTimePeriodId: seed, date: target });

            if (reached === undefined) {
                logger.debug(`[clarity] carousel could not reach ${target} from period ${seed}`);
                continue;
            }

            const window = await api.getTimesheetApp(reached);

            for (const week of parseCarouselEntries(window.tscarousel?._results ?? [], entryCountMap)) {
                if (!merged.some((known) => known.timePeriodId === week.timePeriodId)) {
                    merged.push(week);
                }
            }
        } catch (err) {
            logger.debug(`[clarity] carousel widening to ${target} failed, keeping the window we have: ${err}`);
        }
    }

    merged.sort((a, b) => a.startDate.localeCompare(b.startDate));

    return merged;
}

export interface TimesheetWeeks {
    weeks: TimesheetWeek[];
    userId?: number;
    /**
     * The timesheet records already read while counting entries. Passing them on saves the caller
     * a second `getTimesheet` for the same weeks.
     */
    records: Map<number, TimesheetRecord>;
}

export async function getTimesheetWeeks(
    api: TimesheetWeekReader,
    month?: number,
    year?: number
): Promise<TimesheetWeeks> {
    // When a month is requested, navigate to a period covering it so the window is anchored there.
    const seedTimePeriodId = await resolveCarouselSeed({ api });
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

    const records = new Map<number, TimesheetRecord>();

    if (!carousel?.length) {
        return { weeks: [], userId, records };
    }

    // Build a map of timesheetId → numberOfEntries from the timesheets section (current period)
    const entryCountMap = new Map<number, number>();

    for (const ts of app.timesheets?._results ?? []) {
        entryCountMap.set(ts._internalId, ts.numberOfEntries ?? 0);
    }

    let weeks = parseCarouselEntries(carousel, entryCountMap);

    if (month !== undefined && year !== undefined) {
        const { monthStart, monthEnd } = monthBounds(year, month);
        weeks = await widenToCoverMonth({ api, weeks, entryCountMap, monthStart, monthEnd, seedTimePeriodId });
        weeks = weeksTouchingMonth(weeks, year, month);
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
                return { timesheetId: w.timesheetId, record };
            })
        );

        for (const result of results) {
            if (result.status !== "fulfilled") {
                logger.debug(`[clarity] entry count fetch failed: ${result.reason}`);
                continue;
            }

            const week = weeks.find((w) => w.timesheetId === result.value.timesheetId);

            if (week) {
                week.entryCount = result.value.record?.numberOfEntries ?? 0;
            }

            if (result.value.record) {
                records.set(result.value.timesheetId, result.value.record);
            }
        }
    }

    return { weeks, userId, records };
}

/**
 * Pick the period covering a date, opened or not. Clarity periods share a boundary date, so the
 * range is half-open: the finish date belongs to the next period, not this one.
 */
export function findPeriodForDate(weeks: TimesheetWeek[], date: string): TimesheetWeek | undefined {
    return weeks.find((week) => isDateInHalfOpenRange(date, week.startDate, week.finishDate));
}

/**
 * Pick the period covering a date, skipping future periods that carry no timesheet id yet, because
 * the API rejects `timesheetId=undefined`. Use `findPeriodForDate` when an unopened period should
 * be reported rather than dropped.
 */
export function findWeekForDate(weeks: TimesheetWeek[], date: string): IdentifiedTimesheetWeek | undefined {
    const week = findPeriodForDate(weeks, date);

    return week && hasTimesheetId(week) ? week : undefined;
}

/**
 * Select periods for a `--date` argument. A full `YYYY-MM-DD` picks the single covering period;
 * a `YYYY-MM` picks every period that reaches into that month. Periods Clarity has not opened yet
 * are included, so a caller that writes can report them instead of silently doing less.
 */
export function selectWeeksForDateArg(weeks: TimesheetWeek[], dateArg: string): TimesheetWeek[] {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
        const week = findPeriodForDate(weeks, dateArg);

        return week ? [week] : [];
    }

    if (!/^\d{4}-\d{2}$/.test(dateArg)) {
        throw new Error(`Invalid --date '${dateArg}': expected YYYY-MM-DD or YYYY-MM`);
    }

    const [year, month] = dateArg.split("-").map(Number);

    return weeksTouchingMonth(weeks, year, month);
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
