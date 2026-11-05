import { Api } from "@app/azure-devops/api";
import { type WorkItemNode, walkAncestorsBatched } from "@app/azure-devops/lib/ancestors";
import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { getTimeLogApi } from "@app/azure-devops/lib/timelog-client";
import { parseRelations } from "@app/azure-devops/relations";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { WorkItemFull } from "@app/azure-devops/types";
import { requireConfig as requireAdoConfig } from "@app/azure-devops/utils";
import { requireConfig } from "@app/clarity/config";
import { getClarityApi } from "@app/clarity/lib/api";
import { type AssignmentRows, buildAssignmentRows } from "@app/clarity/lib/assignments";
import { loadTaskCatalogue, type TimesheetWeekReader } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";

export interface AssignmentView extends AssignmentRows {
    tasks: ClarityTask[];
    chains: Map<number, WorkItemNode[]>;
    month: number;
    year: number;
}

/** The work item read the ancestor walk needs. */
export interface WorkItemReader {
    getWorkItems(
        ids: number[],
        options: { comments: boolean }
    ): Promise<Map<number, Pick<WorkItemFull, "title" | "rawFields" | "relations">>>;
}

/** The clients the view reads through. Each defaults to the configured one. */
export interface AssignmentViewClients {
    clarityApi?: TimesheetWeekReader;
    timeLogApi?: TimeLogApi;
    workItemApi?: WorkItemReader;
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
export async function buildAssignmentView(date: string, clients: AssignmentViewClients = {}): Promise<AssignmentView> {
    const clarityConfig = await requireConfig();
    const clarityApi = clients.clarityApi ?? getClarityApi();
    const timeLogApi = clients.timeLogApi ?? getTimeLogApi();
    const { month, year } = parseMonthArg(date);

    const monthExport = await exportMonth(timeLogApi, month, year, timeLogApi.user.userId);
    const minutesByWorkItem = new Map<number, number>();

    for (const entry of monthExport.entries) {
        minutesByWorkItem.set(entry.workItemId, (minutesByWorkItem.get(entry.workItemId) ?? 0) + entry.minutes);
    }

    const tasks = await loadTaskCatalogue(clarityApi, { month, year });
    const workItemApi = clients.workItemApi ?? new Api(requireAdoConfig());
    const chains = await walkAncestorsBatched({
        ids: [...minutesByWorkItem.keys()],
        fetchMany: async (ids) => {
            // `comments` defaults to true, and that costs one HTTP request PER work item on top of
            // the batched fields call, at every level of the climb. Only the title, the type and
            // the parent are read below, so the comments were fetched and thrown away. Removing the
            // depth cap is what made it worth naming: the walk now runs to the root.
            const items = await workItemApi.getWorkItems(ids, { comments: false });
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
