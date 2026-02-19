import logger from "@app/logger";
import type {
    CreateEventInput,
    TimelyAccount,
    TimelyEntry,
    TimelyEvent,
    TimelyProject,
    TimelyUser,
} from "@app/timely/types";
import type { Storage } from "@app/utils/storage";
import type { TimelyApiClient } from "./client";

export interface GetEventsParams {
    since?: string; // YYYY-MM-DD
    upto?: string; // YYYY-MM-DD
    day?: string; // YYYY-MM-DD (single day)
    page?: number;
    per_page?: number;
    sort?: "updated_at" | "id" | "day";
    order?: "asc" | "desc";
}

/**
 * TimelyService provides all API endpoint methods
 * Wraps TimelyApiClient with convenient methods for accounts, projects, events, etc.
 */
export class TimelyService {
    constructor(
        private client: TimelyApiClient,
        private storage: Storage
    ) {}

    // ============================================
    // Accounts
    // ============================================

    /**
     * Get all accounts for the authenticated user
     */
    async getAccounts(): Promise<TimelyAccount[]> {
        return this.client.get<TimelyAccount[]>("/accounts");
    }

    /**
     * Get a specific account by ID
     */
    async getAccount(accountId: number): Promise<TimelyAccount> {
        return this.client.get<TimelyAccount>(`/accounts/${accountId}`);
    }

    // ============================================
    // Projects
    // ============================================

    /**
     * Get all projects for an account
     */
    async getProjects(accountId: number): Promise<TimelyProject[]> {
        return this.client.get<TimelyProject[]>(`/${accountId}/projects`);
    }

    /**
     * Get a specific project
     */
    async getProject(accountId: number, projectId: number): Promise<TimelyProject> {
        return this.client.get<TimelyProject>(`/${accountId}/projects/${projectId}`);
    }

    // ============================================
    // Events
    // ============================================

    /**
     * Get events for an account
     */
    async getEvents(accountId: number, params: GetEventsParams = {}): Promise<TimelyEvent[]> {
        return this.client.get<TimelyEvent[]>(`/${accountId}/events`, {
            ...params,
            per_page: params.per_page ?? 100,
        });
    }

    /**
     * Get all events for a date range (handles pagination)
     */
    async getAllEvents(accountId: number, params: GetEventsParams): Promise<TimelyEvent[]> {
        const allEvents: TimelyEvent[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const events = await this.getEvents(accountId, {
                ...params,
                page,
                per_page: perPage,
            });

            allEvents.push(...events);

            if (events.length < perPage) {
                break; // No more pages
            }

            page++;
        }

        return allEvents;
    }

    /**
     * Create a new event
     */
    async createEvent(accountId: number, event: CreateEventInput): Promise<TimelyEvent> {
        return this.client.post<TimelyEvent>(`/${accountId}/events`, { event });
    }

    // ============================================
    // Users
    // ============================================

    /**
     * Get all users for an account
     */
    async getUsers(accountId: number): Promise<TimelyUser[]> {
        return this.client.get<TimelyUser[]>(`/${accountId}/users`);
    }

    /**
     * Get a specific user
     */
    async getUser(accountId: number, userId: number): Promise<TimelyUser> {
        return this.client.get<TimelyUser>(`/${accountId}/users/${userId}`);
    }

    // ============================================
    // Entries
    // ============================================

    /**
     * Fetch entry data for a given entry ID
     * Tries multiple endpoints and caches the result
     */
    async getEntry(accountId: number, entryId: number, accessToken: string): Promise<TimelyEntry[] | null> {
        const cacheKey = `entries/entry-${entryId}.json`;
        const ttl = "7 days"; // Cache entries for 7 days

        try {
            const entries = await this.storage.getFileOrPut<TimelyEntry[]>(
                cacheKey,
                async () => {
                    // Try different possible endpoints for entries
                    const endpoints = [`https://app.timelyapp.com/${accountId}/entries.json?id=${entryId}`];

                    for (const url of endpoints) {
                        try {
                            logger.debug(`[entry] Trying to fetch ${entryId} from ${url}...`);
                            const response = await fetch(url, {
                                method: "GET",
                                headers: {
                                    accept: "application/json",
                                    "content-type": "application/json",
                                    Authorization: `Bearer ${accessToken}`,
                                },
                            });

                            if (response.ok) {
                                const data = await response.json();
                                logger.debug(`[entry] Successfully fetched ${entryId}`);
                                // Handle both direct data array and wrapped response format
                                if (Array.isArray(data)) {
                                    return data;
                                }
                                // If wrapped in { data: [...] }, unwrap it
                                if (data && typeof data === "object" && "data" in data && Array.isArray(data.data)) {
                                    return data.data;
                                }
                                // If it's a single entry object, wrap in array
                                if (data && typeof data === "object" && "id" in data) {
                                    return [data as TimelyEntry];
                                }
                                return [];
                            }
                        } catch (error: any) {
                            logger.debug(`[entry] Failed to fetch from ${url}: ${error.message}`);
                        }
                    }

                    // If all endpoints fail, return empty array
                    logger.debug(`[entry] Could not fetch entry ${entryId} from any endpoint`);
                    return [];
                },
                ttl
            );

            // Storage.getFileOrPut always returns unwrapped data (array of TimelyEntry)
            return entries;
        } catch (error: any) {
            logger.debug(`[entry] Error fetching entry ${entryId}: ${error.message}`);
            return null;
        }
    }
}
