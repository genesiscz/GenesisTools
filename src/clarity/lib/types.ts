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

export interface TimelogWorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
    totalMinutes: number;
    entryCount: number;
}
