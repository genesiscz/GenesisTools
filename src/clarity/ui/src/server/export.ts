import { loadConfig as loadAdoConfig } from "@app/azure-devops/config";
import { exportMonth, type MonthExport } from "@app/azure-devops/lib/timelog/export";
import { enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfigWithTimeLog } from "@app/azure-devops/types";
import { getTimelogWorkItems, type TimelogWorkItemGroup } from "@app/clarity/lib/timelog-workitems";

export type { TimelogWorkItemGroup };

function requireAdoConfig(): AzureConfigWithTimeLog {
    const adoConfig = loadAdoConfig() as AzureConfigWithTimeLog | null;

    if (!adoConfig) {
        throw new Error("Azure DevOps not configured. Run: tools azure-devops configure <url>");
    }

    if (!adoConfig.timelog?.functionsKey) {
        throw new Error("TimeLog not configured. Run: tools azure-devops timelog configure");
    }

    if (!adoConfig.timelog.defaultUser) {
        throw new Error("TimeLog user not configured. Run: tools azure-devops timelog configure");
    }

    return adoConfig;
}

function createTimeLogApi(adoConfig: AzureConfigWithTimeLog): TimeLogApi {
    if (!adoConfig.orgId) {
        throw new Error("Organization ID missing from config. Re-run: tools azure-devops configure <url>");
    }

    const user = adoConfig.timelog!.defaultUser!;
    return new TimeLogApi(adoConfig.orgId, adoConfig.projectId, adoConfig.timelog!.functionsKey, user);
}

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
        const workItems = await enrichWorkItems(adoConfig, uniqueIds, { force: options?.force });

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

export async function getExportData(month: number, year: number, options?: { force?: boolean }): Promise<MonthExport> {
    const adoConfig = requireAdoConfig();
    const adoApi = createTimeLogApi(adoConfig);
    const result = await exportMonth(adoApi, month, year, adoConfig.timelog!.defaultUser!.userId);

    await enrichExportEntries(result, adoConfig, options);

    return result;
}

export async function getTimelogEntries(month: number, year: number): Promise<{ workItems: TimelogWorkItemGroup[] }> {
    const adoConfig = requireAdoConfig();
    const adoApi = createTimeLogApi(adoConfig);
    return getTimelogWorkItems(adoApi, adoConfig, month, year, adoConfig.timelog!.defaultUser!.userId);
}
