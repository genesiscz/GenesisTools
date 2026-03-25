import { SafeJSON } from "@app/utils/json";
import type {
    ApiDebugInfo,
    CarouselEntry,
    TimesheetAppResponse,
    TimesheetResponse,
    UpdateTimeEntryRequest,
    UpdateTimesheetStatusRequest,
} from "./types/index.js";

export interface ClarityApiConfig {
    baseUrl: string;
    authToken: string;
    sessionId: string;
    cookies?: string;
}

export class ClarityApi {
    private config: ClarityApiConfig;

    constructor(config: ClarityApiConfig) {
        this.config = config;
    }

    private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
        const url = `${this.config.baseUrl}/ppm/rest/v1${path}`;
        const signal = options.signal ?? AbortSignal.timeout(30_000);
        const response = await fetch(url, {
            ...options,
            signal,
            tls: { rejectUnauthorized: false },
            headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json",
                authToken: this.config.authToken,
                "Cache-Control": "no-cache",
                "x-api-force-patch": "true",
                "x-api-full-response": "true",
                Cookie: this.config.cookies || `sessionId=${this.config.sessionId}`,
                ...(options.headers as Record<string, string>),
            },
        });

        const text = await response.text();

        if (!response.ok) {
            throw new Error(`Clarity API error ${response.status}: ${text.slice(0, 500)}`);
        }

        try {
            return SafeJSON.parse(text, { strict: true }) as T;
        } catch {
            const isHtml = text.trimStart().startsWith("<");
            const hint = isHtml ? "Session expired — re-authenticate in Settings" : text.slice(0, 300);
            throw new Error(`Clarity API returned non-JSON (${response.status}): ${hint}`);
        }
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
            body: SafeJSON.stringify(body),
        });
    }

    /** Update time entry with full debug info (request URL, body, response) */
    async updateTimeEntryVerbose(
        timesheetId: number,
        timeEntryId: number,
        body: UpdateTimeEntryRequest
    ): Promise<{ data: unknown; debug: ApiDebugInfo }> {
        const path = `/timesheets/${timesheetId}/timeEntries/${timeEntryId}`;
        const url = `${this.config.baseUrl}/ppm/rest/v1${path}`;
        const bodyStr = SafeJSON.stringify(body);

        const response = await fetch(url, {
            method: "PUT",
            tls: { rejectUnauthorized: false },
            headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json",
                authToken: this.config.authToken,
                "Cache-Control": "no-cache",
                "x-api-force-patch": "true",
                "x-api-full-response": "true",
                Cookie: this.config.cookies || `sessionId=${this.config.sessionId}`,
            },
            body: bodyStr,
        });

        const text = await response.text();
        let responseBody: unknown;

        try {
            responseBody = SafeJSON.parse(text, { strict: true });
        } catch {
            responseBody = text.slice(0, 2000);
        }

        const debug: ApiDebugInfo = {
            url,
            method: "PUT",
            requestBody: body,
            responseStatus: response.status,
            responseBody,
        };

        if (!response.ok) {
            const err = new Error(`Clarity API error ${response.status}: ${text.slice(0, 500)}`);
            (err as Error & { debug: ApiDebugInfo }).debug = debug;
            throw err;
        }

        return { data: responseBody, debug };
    }

    /** Submit timesheet (status=1) */
    async submitTimesheet(timesheetId: number): Promise<unknown> {
        const body: UpdateTimesheetStatusRequest = { status: "1" };
        return this.request(`/timesheets/${timesheetId}`, {
            method: "PUT",
            body: SafeJSON.stringify(body),
            headers: { "x-api-include-additional-messages": "true" },
        });
    }

    /** Revert timesheet to allow edits (status=2) */
    async revertTimesheet(timesheetId: number): Promise<unknown> {
        const body: UpdateTimesheetStatusRequest = { status: "2" };
        return this.request(`/timesheets/${timesheetId}`, {
            method: "PUT",
            body: SafeJSON.stringify(body),
            headers: { "x-api-include-additional-messages": "true" },
        });
    }
}
