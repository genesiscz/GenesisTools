import { isDateInHalfOpenRange } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import type {
    ApiDebugInfo,
    CarouselEntry,
    CreateTimeEntryRequest,
    CreateTimesheetNoteRequest,
    TimesheetAppResponse,
    TimesheetResponse,
    TimesheetWithNotesResponse,
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

    /** The one place headers and TLS are set, so an auth change cannot land in half the verbs. */
    private async send(path: string, options: RequestInit = {}): Promise<Response> {
        const url = `${this.config.baseUrl}/ppm/rest/v1${path}`;
        const signal = options.signal ?? AbortSignal.timeout(30_000);

        return fetch(url, {
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
    }

    private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
        const response = await this.send(path, options);
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`Clarity API error ${response.status}: ${text.slice(0, 500)}`);
        }

        if (text.trim() === "") {
            return undefined as T;
        }

        try {
            return SafeJSON.parse(text, { strict: true }) as T;
        } catch {
            const isHtml = text.trimStart().startsWith("<");
            const hint = isHtml ? "Session expired — re-authenticate in Settings" : text.slice(0, 300);
            throw new Error(`Clarity API returned non-JSON (${response.status}): ${hint}`);
        }
    }

    /** Same request, for verbs whose success body is empty and would fail a JSON parse. */
    private async requestVoid(path: string, options: RequestInit = {}): Promise<void> {
        const response = await this.send(path, options);
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`Clarity API error ${response.status}: ${text.slice(0, 500)}`);
        }

        // An expired session answers 200 with an HTML login page. Trusting `response.ok` alone
        // would report a write that never reached Clarity as a success.
        if (text.trimStart().startsWith("<")) {
            throw new Error(`Clarity API returned a login page (${response.status}): session expired`);
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
            if (isDateInHalfOpenRange(target, entry.start_date, entry.finish_date)) {
                return entry;
            }
        }

        return null;
    }

    /**
     * Add a task row to a timesheet. `taskId` is the only field the caller supplies; the server
     * fills assignmentId, resourceId, role, investmentId and phaseId from the assignment.
     */
    async createTimeEntry(timesheetId: number, taskId: number): Promise<unknown> {
        const body: CreateTimeEntryRequest = { taskId };
        return this.request(`/timesheets/${timesheetId}/timeEntries`, {
            method: "POST",
            body: SafeJSON.stringify(body),
        });
    }

    /** Remove a task row from a timesheet. Answers 200 with an empty body. */
    async deleteTimeEntry(timesheetId: number, timeEntryId: number): Promise<void> {
        await this.requestVoid(`/timesheets/${timesheetId}/timeEntries/${timeEntryId}`, { method: "DELETE" });
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

    /** Fetch timesheet with expanded notes */
    async getTimesheetWithNotes(timesheetId: number): Promise<TimesheetWithNotesResponse> {
        const expand = encodeURIComponent(
            "(timesheetNotes=(fields=(noteText,createdDate,author,lastUpdatedDate,resourceName,resourceFirstName,resourceId,noteDate),limit=500,sort=(lastUpdatedDate desc)))"
        );
        return this.request<TimesheetWithNotesResponse>(`/timesheets/${timesheetId}?expand=${expand}`);
    }

    /** Post a note to a timesheet. Returns void — API returns 200 with empty body. */
    async createTimesheetNote(timesheetId: number, noteText: string, authorUserId: number): Promise<void> {
        const url = `${this.config.baseUrl}/ppm/rest/v1/timesheets/${timesheetId}/timesheetNotes`;
        const body: CreateTimesheetNoteRequest = { noteText, author: authorUserId };

        const response = await fetch(url, {
            method: "POST",
            signal: AbortSignal.timeout(30_000),
            tls: { rejectUnauthorized: false },
            headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json;charset=UTF-8",
                authToken: this.config.authToken,
                "Cache-Control": "no-cache",
                "x-api-full-response": "true",
                Cookie: this.config.cookies || `sessionId=${this.config.sessionId}`,
            },
            body: SafeJSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to post timesheet note (${response.status}): ${text.slice(0, 500)}`);
        }
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
