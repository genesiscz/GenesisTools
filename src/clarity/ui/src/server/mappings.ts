import type { ClarityMapping } from "@app/clarity/config";
import { getConfig, saveConfig } from "@app/clarity/config";
import { getTimesheetWeeks as getTimesheetWeeksShared, type TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
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

export type { TimesheetWeek };

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

    return getTimesheetWeeksShared(api, config.mappings, month, year);
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
