import type { IndexedLogEntry, SessionMeta } from "@app/debugging-master/types";

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
    return (await res.json()) as T;
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
