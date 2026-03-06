import type { ClarityMapping } from "@app/clarity/config";
import { getConfig, saveConfig } from "@app/clarity/config";
import type { TimeEntryRecord } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";

interface ClarityTask {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
    timeEntryId: number;
}

interface TimesheetWeek {
    timesheetId: number;
    timePeriodId: number;
    startDate: string;
    finishDate: string;
    totalHours: number;
    status: string;
}

export async function getTimesheetWeeks(month?: number, year?: number): Promise<{ weeks: TimesheetWeek[] }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    const api = new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
    });

    // Try to find a valid timePeriodId to seed the carousel
    const timePeriodId = await findValidTimePeriodId(api, config.mappings);

    const app = await api.getTimesheetApp(timePeriodId);
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
        return { weeks: [] };
    }

    let weeks: TimesheetWeek[] = carousel.map((entry) => ({
        timesheetId: entry.timesheet_id,
        timePeriodId: entry.id,
        startDate: entry.start_date.split("T")[0],
        finishDate: entry.finish_date.split("T")[0],
        totalHours: entry.total,
        status: entry.prstatus?.displayValue ?? "unknown",
    }));

    // Filter to weeks that overlap the requested month/year
    if (month !== undefined && year !== undefined) {
        const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

        weeks = weeks.filter((w) => w.startDate <= monthEnd && w.finishDate >= monthStart);
    }

    return { weeks };
}

async function findValidTimePeriodId(api: ClarityApi, mappings: ClarityMapping[]): Promise<number> {
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
        } catch {
            // Timesheet might no longer exist, try next
        }
    }

    // Strategy 2: Fall back to 0 (current period) and hope the response has data
    return 0;
}

export async function getMappings(): Promise<{ mappings: ClarityMapping[]; configured: boolean }> {
    const config = await getConfig();

    if (!config) {
        return { mappings: [], configured: false };
    }

    return { mappings: config.mappings, configured: true };
}

export async function addMapping(data: Record<string, unknown>): Promise<{ success: boolean }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    const mapping: ClarityMapping = {
        clarityTaskId: data.clarityTaskId as number,
        clarityTaskName: data.clarityTaskName as string,
        clarityTaskCode: data.clarityTaskCode as string,
        clarityInvestmentName: data.clarityInvestmentName as string,
        clarityInvestmentCode: data.clarityInvestmentCode as string,
        adoWorkItemId: data.adoWorkItemId as number,
        adoWorkItemTitle: data.adoWorkItemTitle as string,
        adoWorkItemType: data.adoWorkItemType as string | undefined,
    };

    const existing = config.mappings.findIndex((m) => m.adoWorkItemId === mapping.adoWorkItemId);

    if (existing >= 0) {
        config.mappings[existing] = mapping;
    } else {
        config.mappings.push(mapping);
    }

    await saveConfig(config);
    return { success: true };
}

export async function getClarityTasks(timesheetId: number): Promise<{ tasks: ClarityTask[] }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    const api = new ClarityApi({
        baseUrl: config.baseUrl,
        authToken: config.authToken,
        sessionId: config.sessionId,
    });

    const data = await api.getTimesheet(timesheetId);
    const ts = data.timesheets._results[0];

    if (!ts) {
        throw new Error(`Timesheet ${timesheetId} not found`);
    }

    const tasks: ClarityTask[] = ts.timeentries._results.map((e: TimeEntryRecord) => ({
        taskId: e.taskId,
        taskName: e.taskName,
        taskCode: e.taskCode,
        investmentName: e.investmentName,
        investmentCode: e.investmentCode,
        timeEntryId: e._internalId,
    }));

    return { tasks };
}

export async function removeMapping(adoWorkItemId: number): Promise<{ success: boolean }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    config.mappings = config.mappings.filter((m) => m.adoWorkItemId !== adoWorkItemId);
    await saveConfig(config);
    return { success: true };
}
