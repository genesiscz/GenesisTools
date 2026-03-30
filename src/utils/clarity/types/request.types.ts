import type { TimeSeriesValue } from "./response.types.js";

export interface UpdateTimeEntryRequest {
    taskId: number;
    actuals: TimeSeriesValue;
}

export interface CreateTimesheetNoteRequest {
    noteText: string;
    author: number;
}

export interface UpdateTimesheetStatusRequest {
    status: "0" | "1" | "2"; // 0=Open, 1=Submit, 2=Revert
}
