import type { ClarityConfig, ClarityMapping } from "@app/clarity/config";
import { getConfig } from "@app/clarity/config";
import { getClarityApi } from "@app/clarity/lib/api";
import { MappingStore, parseMappingPayload } from "@app/clarity/lib/mapping-store";
import { listClarityTasks } from "@app/clarity/lib/tasks";
import { getTimesheetWeeks as getTimesheetWeeksShared, type TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";
import { invalidateAssignmentView } from "@app/clarity/ui/src/server/assignments";

export type { TimesheetWeek };

export async function getTimesheetWeeks(month?: number, year?: number): Promise<{ weeks: TimesheetWeek[] }> {
    const api = getClarityApi();

    return getTimesheetWeeksShared(api, month, year);
}

export async function getMappings(): Promise<{ mappings: ClarityMapping[]; configured: boolean }> {
    const config = await getConfig();

    if (!config) {
        return { mappings: [], configured: false };
    }

    return { mappings: config.mappings, configured: true };
}

const store = new MappingStore({ onChange: () => invalidateAssignmentView() });

async function configOrThrow(): Promise<ClarityConfig> {
    const config = await getConfig();

    if (!config) {
        throw new Error("Clarity not configured");
    }

    return config;
}

export async function addMapping(data: Record<string, unknown>): Promise<{ success: boolean }> {
    const config = await configOrThrow();

    await store.upsert(config, [parseMappingPayload(data)]);
    return { success: true };
}

export async function getClarityTasks(timesheetId: number): Promise<{ tasks: ClarityTask[] }> {
    const api = getClarityApi();

    return { tasks: await listClarityTasks({ api, timesheetId }) };
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
    const config = await configOrThrow();

    await store.move(config, adoWorkItemId, {
        taskId: target.clarityTaskId,
        taskName: target.clarityTaskName,
        taskCode: target.clarityTaskCode,
        investmentName: target.clarityInvestmentName,
        investmentCode: target.clarityInvestmentCode,
    });
    return { success: true };
}

export async function removeMapping(adoWorkItemId: number): Promise<{ success: boolean }> {
    const config = await configOrThrow();

    await store.remove(config, [adoWorkItemId]);
    return { success: true };
}
