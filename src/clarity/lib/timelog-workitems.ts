import { exportMonth } from "@app/azure-devops/lib/timelog/export";
import { type EnrichedWorkItem, enrichWorkItems } from "@app/azure-devops/lib/work-item-enrichment";
import type { TimeLogApi } from "@app/azure-devops/timelog-api";
import type { AzureConfig } from "@app/azure-devops/types";

export interface TimelogWorkItemGroup {
    id: number;
    title: string;
    type: string;
    state: string;
    totalMinutes: number;
    entryCount: number;
}

export interface TimelogWorkItemsResult {
    workItems: TimelogWorkItemGroup[];
    enrichmentError?: string;
}

export async function getTimelogWorkItems(
    adoApi: TimeLogApi,
    adoConfig: AzureConfig,
    month: number,
    year: number,
    userId: string
): Promise<TimelogWorkItemsResult> {
    const result = await exportMonth(adoApi, month, year, userId);

    const uniqueIds = [...new Set(result.entries.map((e) => e.workItemId))];
    let workItemMap = new Map<number, EnrichedWorkItem>();
    let enrichmentError: string | undefined;

    if (uniqueIds.length > 0) {
        try {
            workItemMap = await enrichWorkItems(adoConfig, uniqueIds);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[clarity-lib] Failed to enrich timelog entries:", msg);
            enrichmentError = msg;
        }
    }

    const workItems: TimelogWorkItemGroup[] = Object.entries(result.summary.entriesByWorkItem).map(
        ([idStr, summary]) => {
            const id = Number(idStr);
            const wi = workItemMap.get(id);

            return {
                id,
                title: wi?.title || summary.title || `Work Item #${id}`,
                type: wi?.type ?? "",
                state: wi?.state ?? "",
                totalMinutes: summary.minutes,
                entryCount: summary.count,
            };
        }
    );

    return { workItems, enrichmentError };
}
