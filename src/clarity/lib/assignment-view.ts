import { Api } from "@app/azure-devops/api";
import { type WorkItemNode, walkAncestorsBatched } from "@app/azure-devops/lib/ancestors";
import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { parseRelations } from "@app/azure-devops/relations";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import { requireConfig as requireAdoConfig, requireTimeLogConfig, requireTimeLogUser } from "@app/azure-devops/utils";
import { requireConfig } from "@app/clarity/config";
import { type AssignmentRows, buildAssignmentRows } from "@app/clarity/lib/assignments";
import { listClarityTasks } from "@app/clarity/lib/tasks";
import {
    findWeekForDate,
    getTimesheetWeeks,
    hasTimesheetId,
    type TimesheetWeek,
    taskSourceWeekOrder,
} from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";
import { ClarityApi } from "@genesiscz/utils/clarity";

export interface AssignmentView extends AssignmentRows {
    tasks: ClarityTask[];
    chains: Map<number, WorkItemNode[]>;
    month: number;
    year: number;
}

export function parseMonthArg(date: string): { month: number; year: number } {
    const [year, month] = date.split("-").map(Number);

    if (!year || !month || month < 1 || month > 12) {
        throw new Error(`Invalid date '${date}': expected YYYY-MM or YYYY-MM-DD`);
    }

    return { month, year };
}

/**
 * Assemble everything the assignment surfaces need: the month's work items split into mapped and
 * unmapped, the Clarity task catalogue, and a tree-based recommendation per work item. Shared by
 * the CLI and the dashboard so both answer identically.
 */
async function firstNonEmptyCatalogue(api: ClarityApi, candidates: TimesheetWeek[]): Promise<ClarityTask[]> {
    for (const candidate of candidates) {
        if (!hasTimesheetId(candidate)) {
            continue;
        }

        const tasks = await listClarityTasks({ api, timesheetId: candidate.timesheetId });

        if (tasks.length > 0) {
            return tasks;
        }
    }

    return [];
}

export async function buildAssignmentView(date: string): Promise<AssignmentView> {
    const clarityConfig = await requireConfig();
    const adoConfig = requireTimeLogConfig();
    const adoUser = requireTimeLogUser(adoConfig);
    const { month, year } = parseMonthArg(date);

    const timeLogApi = new TimeLogApi(adoConfig.orgId!, adoConfig.projectId, adoConfig.timelog!.functionsKey, adoUser);
    const clarityApi = new ClarityApi({
        baseUrl: clarityConfig.baseUrl,
        authToken: clarityConfig.authToken,
        sessionId: clarityConfig.sessionId,
        cookies: clarityConfig.cookies,
    });

    const monthExport = await exportMonth(timeLogApi, month, year, adoUser.userId);
    const minutesByWorkItem = new Map<number, number>();

    for (const entry of monthExport.entries) {
        minutesByWorkItem.set(entry.workItemId, (minutesByWorkItem.get(entry.workItemId) ?? 0) + entry.minutes);
    }

    const { weeks } = await getTimesheetWeeks(clarityApi, clarityConfig.mappings, month, year);
    const preferred = findWeekForDate(weeks, `${year}-${String(month).padStart(2, "0")}-15`);
    let tasks = await firstNonEmptyCatalogue(clarityApi, taskSourceWeekOrder(weeks, preferred));

    if (tasks.length === 0) {
        // A month whose timesheets exist but carry no rows yet has no catalogue of its own.
        // Widen past the month filter and take the newest period that does have rows.
        const { weeks: anyWeek } = await getTimesheetWeeks(clarityApi, clarityConfig.mappings);
        tasks = await firstNonEmptyCatalogue(clarityApi, taskSourceWeekOrder(anyWeek, undefined));
    }

    const workItemApi = new Api(requireAdoConfig());
    const chains = await walkAncestorsBatched({
        ids: [...minutesByWorkItem.keys()],
        maxDepth: 3,
        fetchMany: async (ids) => {
            const items = await workItemApi.getWorkItems(ids);
            const nodes = new Map<number, WorkItemNode>();

            for (const [id, item] of items) {
                nodes.set(id, {
                    id,
                    title: item.title,
                    type: String(item.rawFields?.["System.WorkItemType"] ?? "?"),
                    parent: parseRelations(item.relations ?? []).parent,
                });
            }

            return nodes;
        },
    });

    const rows = buildAssignmentRows({ minutesByWorkItem, mappings: clarityConfig.mappings, chains, tasks });

    return { ...rows, tasks, chains, month, year };
}
