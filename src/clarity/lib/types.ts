export interface ClarityTask {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
    timeEntryId: number;
}

export interface AdoWorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
}

export type { WorkItemParentRef } from "@app/azure-devops/lib/work-item-enrichment";

import type { WorkItemParentRef } from "@app/azure-devops/lib/work-item-enrichment";

export interface TimelogWorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
    totalMinutes: number;
    entryCount: number;
    parent?: WorkItemParentRef;
}
