import { exportMonth, type MonthExport } from "@app/azure-devops/lib/timelog/export";
import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import {
    getTimelogWorkItems,
    type TimelogWorkItemGroup,
    type TimelogWorkItemsResult,
} from "@app/clarity/lib/timelog-workitems";
import { requireAdoTimeLogConfig } from "@app/clarity/ui/src/server/ado-config";

export type { TimelogWorkItemGroup, TimelogWorkItemsResult };

async function enrichExportEntries(
    result: MonthExport,
    adoConfig: AzureConfigWithTimeLog,
    options?: { force?: boolean }
): Promise<void> {
    const uniqueIds = [...new Set(result.entries.map((e) => e.workItemId))];

    if (uniqueIds.length === 0) {
        return;
    }

    try {
        const workItems = await enrichWorkItems(adoConfig, uniqueIds, {
            force: options?.force,
            includeParents: true,
        });

        for (const entry of result.entries) {
            const wi = workItems.get(entry.workItemId);

            if (wi) {
                entry.workItemTitle = wi.title;
                entry.workItemType = wi.type ?? "";
                entry.workItemParent = wi.parent;
            }
        }

        for (const [id, summary] of Object.entries(result.summary.entriesByWorkItem)) {
            const wi = workItems.get(Number(id));

            if (wi) {
                summary.title = wi.title;
            }
        }
    } catch (err) {
        console.error("[clarity-api] Failed to enrich work item titles:", err);
    }
}

export async function getExportData(month: number, year: number, options?: { force?: boolean }): Promise<MonthExport> {
    const { config: adoConfig, api: adoApi } = requireAdoTimeLogConfig();
    const result = await exportMonth(adoApi, month, year, adoApi.user.userId);

    await enrichExportEntries(result, adoConfig, options);

    return result;
}

export async function getTimelogEntries(month: number, year: number): Promise<TimelogWorkItemsResult> {
    const { config: adoConfig, api: adoApi } = requireAdoTimeLogConfig();
    return getTimelogWorkItems(adoApi, adoConfig, month, year, adoApi.user.userId);
}
