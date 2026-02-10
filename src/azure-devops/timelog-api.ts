/**
 * TimeLog API Client
 *
 * Client for the TimeLog third-party Azure DevOps extension.
 * API Host: boznet-timelogapi.azurewebsites.net
 */

import type {
    CreateTimeLogRequest,
    CreateTimeLogResponse,
    TimeLogEntry,
    TimeLogQueryEntry,
    TimeLogQueryParams,
    TimeLogUser,
    TimeType,
} from "@app/azure-devops/types";
import logger from "@app/logger";
import { buildUrl } from "@app/utils/url";

export class TimeLogApi {
    private projectId: string;
    private functionsKey: string;
    private currentUser: TimeLogUser;
    private baseUrl: string;

    constructor(orgId: string, projectId: string, functionsKey: string, currentUser: TimeLogUser) {
        this.projectId = projectId;
        this.functionsKey = functionsKey;
        this.currentUser = currentUser;
        this.baseUrl = buildUrl({ base: "https://boznet-timelogapi.azurewebsites.net/api", segments: [orgId] });
    }

    /**
     * Make an HTTP request to the TimeLog API
     */
    private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", endpoint: string, body?: unknown): Promise<T> {
        const url = buildUrl({ base: this.baseUrl, segments: [endpoint] });
        const shortUrl = endpoint.slice(0, 60);

        logger.debug(`[timelog-api] ${method} ${shortUrl}`);
        const startTime = Date.now();

        const headers: Record<string, string> = {
            "x-functions-key": this.functionsKey,
            "x-timelog-usermakingchange": encodeURIComponent(this.currentUser.userName),
        };

        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        const response = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const elapsed = Date.now() - startTime;
        logger.debug(`[timelog-api] ${method} response: ${response.status} (${elapsed}ms)`);

        if (!response.ok) {
            const errorText = await response.text();
            logger.debug(`[timelog-api] Error: ${errorText.slice(0, 200)}`);
            throw new Error(`TimeLog API Error ${response.status}: ${errorText}`);
        }

        // Handle empty responses (e.g., DELETE)
        const text = await response.text();
        if (!text) return {} as T;

        return JSON.parse(text) as T;
    }

    /**
     * Get all available time types for the project
     */
    async getTimeTypes(): Promise<TimeType[]> {
        logger.debug("[timelog-api] Fetching time types");
        const types = await this.request<TimeType[]>("GET", `/timetype/project/${this.projectId}`);
        const activeTypes = types.filter((t) => !t.disabled);
        logger.debug(`[timelog-api] Found ${activeTypes.length} active time types`);
        return activeTypes;
    }

    /**
     * Get all time types for the organization (not project-specific)
     */
    async getAllTimeTypes(): Promise<TimeType[]> {
        logger.debug("[timelog-api] Fetching all org time types");
        return this.request<TimeType[]>("GET", "/timetype/project");
    }

    /**
     * Get time log entries for a work item
     */
    async getWorkItemTimeLogs(workItemId: number): Promise<TimeLogEntry[]> {
        logger.debug(`[timelog-api] Fetching time logs for work item #${workItemId}`);
        const entries = await this.request<TimeLogEntry[]>(
            "GET",
            `/timelog/project/${this.projectId}/workitem/${workItemId}`
        );
        logger.debug(`[timelog-api] Found ${entries.length} time log entries`);
        return entries;
    }

    /**
     * Create a new time log entry
     *
     * @param workItemId - The work item to log time against
     * @param minutes - Time in minutes (not hours!)
     * @param timeTypeDescription - Display name of time type (e.g., "Development")
     * @param date - Date in YYYY-MM-DD format
     * @param comment - Optional description of work performed
     * @returns IDs of created log entries
     */
    async createTimeLogEntry(
        workItemId: number,
        minutes: number,
        timeTypeDescription: string,
        date: string,
        comment: string = ""
    ): Promise<string[]> {
        logger.debug(`[timelog-api] Creating time log: ${minutes}min of "${timeTypeDescription}" for #${workItemId}`);

        const request: CreateTimeLogRequest = {
            minutes,
            timeTypeDescription,
            comment,
            date,
            workItemId,
            projectId: this.projectId,
            users: [this.currentUser],
            userMakingChange: this.currentUser.userName,
        };

        const response = await this.request<CreateTimeLogResponse>("POST", "/timelogs/", request);

        logger.debug(`[timelog-api] Created ${response.logsCreated.length} time log entries`);
        return response.logsCreated;
    }

    /**
     * Delete a time log entry
     */
    async deleteTimeLogEntry(timeLogId: string): Promise<void> {
        logger.debug(`[timelog-api] Deleting time log: ${timeLogId}`);
        await this.request<void>("DELETE", `/timelog/${timeLogId}`);
        logger.debug("[timelog-api] Time log deleted");
    }

    /**
     * Query time logs across work items with filters
     * Uses the /timelog/query endpoint
     */
    async queryTimeLogs(params: TimeLogQueryParams): Promise<TimeLogQueryEntry[]> {
        const endpoint = buildUrl({
            base: "/timelog/query",
            queryParams: {
                FromDate: params.FromDate,
                ToDate: params.ToDate,
                projectId: params.projectId,
                workitemId: params.workitemId ? String(params.workitemId) : undefined,
                userId: params.userId,
            },
        });
        logger.debug(`[timelog-api] Querying time logs: ${endpoint}`);
        return this.request<TimeLogQueryEntry[]>("GET", endpoint);
    }

    /**
     * Validate that a time type exists
     */
    async validateTimeType(description: string): Promise<TimeType | null> {
        const types = await this.getTimeTypes();
        return types.find((t) => t.description.toLowerCase() === description.toLowerCase()) || null;
    }
}

/**
 * Convert hours and minutes to total minutes
 * Validates the --hours 0 --minutes rule
 */
export function convertToMinutes(hours: number | undefined, minutes: number | undefined): number {
    // Rule: --minutes alone requires --hours to be explicitly set
    if (minutes !== undefined && hours === undefined) {
        throw new Error(
            "Cannot use --minutes without --hours. " + "Use --hours 0 --minutes N to confirm you meant only minutes."
        );
    }

    const h = hours ?? 0;
    const m = minutes ?? 0;
    const total = h * 60 + m;

    if (total <= 0) {
        throw new Error("Total time must be greater than 0 minutes");
    }

    return total;
}

/**
 * Format minutes as human-readable string
 */
export function formatMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
}

/**
 * Get today's date in YYYY-MM-DD format
 */
export function getTodayDate(): string {
    return new Date().toISOString().split("T")[0];
}
