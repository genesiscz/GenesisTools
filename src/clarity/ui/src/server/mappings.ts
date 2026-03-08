import type { ClarityMapping } from "@app/clarity/config";
import { getConfig, saveConfig } from "@app/clarity/config";
import { getTimesheetWeeks as getTimesheetWeeksShared, type TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";
import type { TimeEntryRecord } from "@app/utils/clarity";
import { ClarityApi } from "@app/utils/clarity";

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
        cookies: config.cookies,
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

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid mapping payload: '${field}' must be a non-empty string`);
    }

    return value;
}

function requireNumber(value: unknown, field: string): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
        throw new Error(`Invalid mapping payload: '${field}' must be a number`);
    }

    return value;
}

export async function addMapping(data: Record<string, unknown>): Promise<{ success: boolean }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    const mapping: ClarityMapping = {
        clarityTaskId: requireNumber(data.clarityTaskId, "clarityTaskId"),
        clarityTaskName: requireString(data.clarityTaskName, "clarityTaskName"),
        clarityTaskCode: requireString(data.clarityTaskCode, "clarityTaskCode"),
        clarityInvestmentName: requireString(data.clarityInvestmentName, "clarityInvestmentName"),
        clarityInvestmentCode: requireString(data.clarityInvestmentCode, "clarityInvestmentCode"),
        adoWorkItemId: requireNumber(data.adoWorkItemId, "adoWorkItemId"),
        adoWorkItemTitle: requireString(data.adoWorkItemTitle, "adoWorkItemTitle"),
        adoWorkItemType: typeof data.adoWorkItemType === "string" ? data.adoWorkItemType : undefined,
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
        cookies: config.cookies,
    });

    const data = await api.getTimesheet(timesheetId);
    const ts = data.timesheets._results[0];

    if (!ts) {
        throw new Error(`Timesheet ${timesheetId} not found`);
    }

    const tasks: ClarityTask[] = (ts.timeentries?._results ?? []).map((e: TimeEntryRecord) => ({
        taskId: e.taskId,
        taskName: e.taskName,
        taskCode: e.taskCode,
        investmentName: e.investmentName,
        investmentCode: e.investmentCode,
        timeEntryId: e._internalId,
    }));

    return { tasks };
}

export async function moveMapping(
    adoWorkItemId: number,
    target: {
        clarityTaskId: number;
        clarityTaskName: string;
        clarityTaskCode: string;
        clarityInvestmentName: string;
        clarityInvestmentCode: string;
    }
): Promise<{ success: boolean }> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    const mapping = config.mappings.find((m) => m.adoWorkItemId === adoWorkItemId);

    if (!mapping) {
        throw new Error(`Mapping for work item ${adoWorkItemId} not found`);
    }

    mapping.clarityTaskId = target.clarityTaskId;
    mapping.clarityTaskName = target.clarityTaskName;
    mapping.clarityTaskCode = target.clarityTaskCode;
    mapping.clarityInvestmentName = target.clarityInvestmentName;
    mapping.clarityInvestmentCode = target.clarityInvestmentCode;

    await saveConfig(config);
    return { success: true };
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
