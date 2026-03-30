import type { ClarityMapping } from "@app/clarity/config";
import type { ClarityApi } from "@app/utils/clarity";

export interface TimesheetWeek {
    timesheetId: number;
    timePeriodId: number;
    startDate: string;
    finishDate: string;
    totalHours: number;
    status: string;
    entryCount?: number;
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
    const seedTimePeriodId = await findValidTimePeriodId(api, mappings);
    let timePeriodId = seedTimePeriodId;

    if (month !== undefined && year !== undefined && seedTimePeriodId !== undefined) {
        const targetDate = new Date(year, month - 1, 15); // mid-month

        try {
            const entry = await api.findTimesheetForDate(seedTimePeriodId, targetDate);

            if (entry) {
                timePeriodId = entry.id;
            }
        } catch {
            // Navigation failed, fall back to the seed period
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

    let weeks: TimesheetWeek[] = carousel.map((entry) => {
        // Handle two response shapes:
        // With filter: timesheet_id, total, prstatus at top level
        // Without filter: nested in tpTimesheet._results[0]
        const raw = entry as unknown as Record<string, unknown>;
        const nested = raw.tpTimesheet as
            | {
                  _results: Array<{
                      timesheet_id: number;
                      total: string;
                      prstatus: { _results: Array<{ displayValue: string }> };
                  }>;
              }
            | undefined;
        const tp = nested?._results?.[0];

        const timesheetId = entry.timesheet_id ?? tp?.timesheet_id;
        const totalRaw: unknown = entry.total ?? tp?.total;
        const total =
            typeof totalRaw === "string"
                ? parseFloat(totalRaw.replace(",", "."))
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
    });

    // If a specific month is requested and the carousel doesn't cover it fully,
    // fetch additional carousel pages by navigating to earlier/later timePeriodIds
    if (month !== undefined && year !== undefined) {
        const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

        // Check if we need earlier weeks
        const firstStart = weeks[0]?.startDate;

        if (firstStart && firstStart > monthStart) {
            // Navigate backwards: use first carousel ID minus offset
            const firstId = weeks[0].timePeriodId;
            const offset = Math.ceil(4); // ~4 weeks back should cover a month boundary

            try {
                const earlier = await api.getTimesheetApp(firstId - offset);
                const earlierCarousel = earlier.tscarousel?._results ?? [];

                for (const entry of earlierCarousel) {
                    const eRaw = entry as unknown as Record<string, unknown>;
                    const eNested = eRaw.tpTimesheet as
                        | {
                              _results: Array<{
                                  timesheet_id: number;
                                  total: string;
                                  prstatus: { _results: Array<{ displayValue: string }> };
                              }>;
                          }
                        | undefined;
                    const eTp = eNested?._results?.[0];
                    const eTimesheetId = entry.timesheet_id ?? eTp?.timesheet_id;
                    const eTotalRaw: unknown = entry.total ?? eTp?.total;
                    const eTotal =
                        typeof eTotalRaw === "string"
                            ? parseFloat(eTotalRaw.replace(",", "."))
                            : typeof eTotalRaw === "number"
                              ? eTotalRaw
                              : 0;
                    const eStatus =
                        entry.prstatus?.displayValue ?? eTp?.prstatus?._results?.[0]?.displayValue ?? "unknown";
                    const sd = entry.start_date.split("T")[0];

                    // Only add if not already in our weeks list
                    if (!weeks.some((w) => w.timePeriodId === entry.id) && sd < firstStart) {
                        weeks.unshift({
                            timesheetId: eTimesheetId,
                            timePeriodId: entry.id,
                            startDate: sd,
                            finishDate: entry.finish_date.split("T")[0],
                            totalHours: eTotal,
                            status: eStatus,
                            entryCount: entryCountMap.get(eTimesheetId),
                        });
                    }
                }

                weeks.sort((a, b) => a.startDate.localeCompare(b.startDate));
            } catch {
                // Navigation failed, return what we have
            }
        }

        weeks = weeks.filter((w) => w.startDate <= monthEnd && w.finishDate > monthStart);
    }

    // Fetch entry counts for weeks that don't have them yet (not in current period's timesheets section)
    const needsCount = weeks.filter((w) => w.entryCount === undefined && w.timesheetId);

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
