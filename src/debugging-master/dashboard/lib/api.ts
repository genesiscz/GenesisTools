import type { IndexedLogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";
import type { DashboardSession, LogSourceId } from "@app/utils/log-viewer/log-source";
import { sessionKey } from "@app/utils/log-viewer/session-key";

export interface SessionsResponse {
    sessions: DashboardSession[];
}

export interface EntriesResponse {
    entries: IndexedLogEntry[];
    total: number;
    source?: LogSourceId;
}

export interface ExpandResponse {
    refId: string;
    index: number;
    level: string;
    data: unknown;
}

async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return SafeJSON.parse(text, { strict: true }) as T;
}

export function sessionRoute(source: LogSourceId, name: string): string {
    return `/api/sessions/${source}/${encodeURIComponent(name)}`;
}

export const api = {
    listSessions(): Promise<SessionsResponse> {
        return getJson<SessionsResponse>("/api/sessions");
    },

    getEntries(source: LogSourceId, sessionName: string, since = 0, limit = 5000): Promise<EntriesResponse> {
        const params = new URLSearchParams({ since: String(since), limit: String(limit) });
        return getJson<EntriesResponse>(`${sessionRoute(source, sessionName)}/entries?${params.toString()}`);
    },

    async getRecentEntries(
        source: LogSourceId,
        sessionName: string,
        limit = 2000
    ): Promise<EntriesResponse> {
        const probe = await api.getEntries(source, sessionName, 0, 1);

        if (probe.total <= limit) {
            return api.getEntries(source, sessionName, 0, probe.total);
        }

        return api.getEntries(source, sessionName, probe.total - limit, limit);
    },

    expand(source: LogSourceId, sessionName: string, refId: string): Promise<ExpandResponse> {
        return getJson<ExpandResponse>(`${sessionRoute(source, sessionName)}/expand/${refId}`);
    },

    async clearSession(source: LogSourceId, sessionName: string): Promise<void> {
        const res = await fetch(`${sessionRoute(source, sessionName)}/clear`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText}`);
        }
    },

    async deleteSession(source: LogSourceId, sessionName: string): Promise<void> {
        const res = await fetch(sessionRoute(source, sessionName), {
            method: "DELETE",
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText}`);
        }
    },
};

export { sessionKey };
