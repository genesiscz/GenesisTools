import type {
    CarouselEntry,
    TimesheetAppResponse,
    TimesheetResponse,
    UpdateTimeEntryRequest,
    UpdateTimesheetStatusRequest,
} from "./types/index.js";

export interface ClarityApiConfig {
    baseUrl: string; // e.g. "https://clarity.example.com"
    authToken: string; // e.g. "34546093__A7F323E6-..."
    sessionId: string; // from cookie
}

export class ClarityApi {
    private config: ClarityApiConfig;

    constructor(config: ClarityApiConfig) {
        this.config = config;
    }

    private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
        const url = `${this.config.baseUrl}/ppm/rest/v1${path}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json",
                authToken: this.config.authToken,
                "Cache-Control": "no-cache",
                "x-api-force-patch": "true",
                "x-api-full-response": "true",
                Cookie: `sessionId=${this.config.sessionId}`,
                ...(options.headers as Record<string, string>),
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Clarity API error ${response.status}: ${text}`);
        }

        return response.json() as Promise<T>;
    }

    /** Fetch a full timesheet with all time entries */
    async getTimesheet(timesheetId: number): Promise<TimesheetResponse> {
        return this.request<TimesheetResponse>(`/private/timesheet?filter=(timesheetId = ${timesheetId})`);
    }

    /** Discover timesheets via timesheetApp (returns carousel with timesheet_id mapping) */
    async getTimesheetApp(timePeriodId?: number): Promise<TimesheetAppResponse> {
        const filter = timePeriodId ? `?filter=(timeperiodId = ${timePeriodId})` : "";
        return this.request<TimesheetAppResponse>(`/private/timesheetApp${filter}`);
    }

    /** Find timesheetId for a specific date by navigating the carousel */
    async findTimesheetForDate(knownTimePeriodId: number, targetDate: Date): Promise<CarouselEntry | null> {
        const app = await this.getTimesheetApp(knownTimePeriodId);
        const target = targetDate.toISOString().split("T")[0];

        for (const entry of app.tscarousel._results) {
            const start = entry.start_date.split("T")[0];
            const finish = entry.finish_date.split("T")[0];

            if (target >= start && target <= finish) {
                return entry;
            }
        }

        return null;
    }

    /** Update time entry hours (segments in seconds: 3600 = 1h) */
    async updateTimeEntry(timesheetId: number, timeEntryId: number, body: UpdateTimeEntryRequest): Promise<unknown> {
        return this.request(`/timesheets/${timesheetId}/timeEntries/${timeEntryId}`, {
            method: "PUT",
            body: JSON.stringify(body),
        });
    }

    /** Submit timesheet (status=1) */
    async submitTimesheet(timesheetId: number): Promise<unknown> {
        const body: UpdateTimesheetStatusRequest = { status: "1" };
        return this.request(`/timesheets/${timesheetId}`, {
            method: "PUT",
            body: JSON.stringify(body),
            headers: { "x-api-include-additional-messages": "true" },
        });
    }

    /** Revert timesheet to allow edits (status=2) */
    async revertTimesheet(timesheetId: number): Promise<unknown> {
        const body: UpdateTimesheetStatusRequest = { status: "2" };
        return this.request(`/timesheets/${timesheetId}`, {
            method: "PUT",
            body: JSON.stringify(body),
            headers: { "x-api-include-additional-messages": "true" },
        });
    }
}
