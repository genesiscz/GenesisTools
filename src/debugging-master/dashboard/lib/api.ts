import type { IndexedLogEntry, SessionMeta } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";

export interface SessionsResponse {
    sessions: SessionMeta[];
}

export interface EntriesResponse {
    entries: IndexedLogEntry[];
    total: number;
}

export interface ExpandResponse {
    refId: string;
    index: number;
    level: string;
    data: unknown;
}

async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
    }
    // SafeJSON in strict mode for API boundaries — repo policy is "always
    // SafeJSON, never JSON" (biome enforces it elsewhere). Strict mode rejects
    // comments / trailing commas so a malformed server response surfaces here
    // instead of being silently coerced.
    const text = await res.text();
    return SafeJSON.parse(text, { strict: true }) as T;
}

export const api = {
    listSessions(): Promise<SessionsResponse> {
        return getJson<SessionsResponse>("/api/sessions");
    },

    getEntries(sessionName: string, since = 0, limit = 5000): Promise<EntriesResponse> {
        const params = new URLSearchParams({ since: String(since), limit: String(limit) });
        return getJson<EntriesResponse>(`/api/sessions/${sessionName}/entries?${params.toString()}`);
    },

    expand(sessionName: string, refId: string): Promise<ExpandResponse> {
        return getJson<ExpandResponse>(`/api/sessions/${sessionName}/expand/${refId}`);
    },

    async clearSession(sessionName: string): Promise<void> {
        const res = await fetch(`/api/sessions/${sessionName}`, { method: "DELETE" });
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText}`);
        }
    },
};
