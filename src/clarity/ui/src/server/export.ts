import { exportMonth, type MonthExport } from "@app/azure-devops/lib/timelog/export";
import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import { enrichWorkItems, type EnrichedWorkItem } from "@app/azure-devops/lib/work-item-enrichment";

function requireAdoConfig(): AzureConfigWithTimeLog {
    const adoConfig = loadAdoConfig() as AzureConfigWithTimeLog | null;

    if (!adoConfig?.orgId || !adoConfig.timelog?.functionsKey) {
        throw new Error("Azure DevOps / TimeLog not configured. Run: tools azure-devops configure");
    }

    if (!adoConfig.timelog.defaultUser) {
        throw new Error("TimeLog user not configured in Azure DevOps config");
    }

    return adoConfig;
}

function createTimeLogApi(adoConfig: AzureConfigWithTimeLog): TimeLogApi {
    const user = adoConfig.timelog!.defaultUser!;
    return new TimeLogApi(adoConfig.orgId, adoConfig.projectId, adoConfig.timelog!.functionsKey, user);
}

async function enrichExportEntries(result: MonthExport, adoConfig: AzureConfigWithTimeLog): Promise<void> {
    const uniqueIds = [...new Set(result.entries.map((e) => e.workItemId))];

    if (uniqueIds.length === 0) {
        return;
    }

    try {
        const workItems = await enrichWorkItems(adoConfig, uniqueIds);

        for (const entry of result.entries) {
            const wi = workItems.get(entry.workItemId);

            if (wi) {
                entry.workItemTitle = wi.title;
                entry.workItemType = wi.type ?? "";
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

export async function getExportData(month: number, year: number): Promise<MonthExport> {
    const adoConfig = requireAdoConfig();
    const adoApi = createTimeLogApi(adoConfig);
    const result = await exportMonth(adoApi, month, year, adoConfig.timelog!.defaultUser!.userId);

    await enrichExportEntries(result, adoConfig);

    return result;
}

export interface TimelogWorkItemGroup {
    id: number;
    title: string;
    type: string;
    state: string;
    totalMinutes: number;
    entryCount: number;
}

export async function getTimelogEntries(
    month: number,
    year: number
): Promise<{ workItems: TimelogWorkItemGroup[] }> {
    const adoConfig = requireAdoConfig();
    const adoApi = createTimeLogApi(adoConfig);
    const result = await exportMonth(adoApi, month, year, adoConfig.timelog!.defaultUser!.userId);

    const uniqueIds = [...new Set(result.entries.map((e) => e.workItemId))];
    let workItemMap = new Map<number, EnrichedWorkItem>();

    if (uniqueIds.length > 0) {
        try {
            workItemMap = await enrichWorkItems(adoConfig, uniqueIds);
        } catch (err) {
            console.error("[clarity-api] Failed to enrich timelog entries:", err);
        }
    }

    const workItems: TimelogWorkItemGroup[] = Object.entries(result.summary.entriesByWorkItem).map(
        ([idStr, summary]) => {
            const id = Number(idStr);
            const wi = workItemMap.get(id);

            return {
                id,
                title: wi?.title ?? summary.title ?? `Work Item #${id}`,
                type: wi?.type ?? "",
                state: wi?.state ?? "",
                totalMinutes: summary.minutes,
                entryCount: summary.count,
            };
        }
    );

    return { workItems };
}
