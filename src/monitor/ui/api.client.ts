import type { NotifySettings, NotifySettingsPatch } from "@app/monitor/lib/notify-settings";
import type { SayVoiceProvider } from "@app/monitor/lib/say-voices";
import type {
    AiAccountOption,
    CheckRecord,
    CheckResult,
    FeedItem,
    Incident,
    IncidentWithWatcher,
    NotifyChannel,
    NotifyTarget,
    NotifyTargetInput,
    NotifyTargetPatch,
    Overview,
    Watcher,
    WatcherInput,
    WatcherPatch,
    WatcherPreset,
    WatcherStatus,
    WatcherSummary,
} from "@app/monitor/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { reportBackendReachable, reportBackendUnreachable } from "./backend-status";

export interface RunResponse {
    watcher: Watcher;
    check: CheckRecord;
    transition: { from: WatcherStatus; to: WatcherStatus; incident: Incident | null } | null;
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string
    ) {
        super(message);
        this.name = "ApiError";
    }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;

    try {
        res = await fetch(`/api/v1${path}`, {
            ...init,
            headers: { "Content-Type": "application/json", ...init.headers },
        });
    } catch (error) {
        reportBackendUnreachable(error instanceof Error ? error.message : "network error");
        throw error;
    }

    // Vite answers 5xx itself when the proxy target is down.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
        reportBackendUnreachable(`HTTP ${res.status} from the API proxy`);
        throw new ApiError(`monitor server unreachable (${res.status})`, res.status);
    }

    reportBackendReachable();

    if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        let code: string | undefined;

        try {
            const body = (await res.json()) as { error?: string; code?: string };
            message = body.error ?? message;
            code = body.code;
        } catch {
            // non-JSON error body: keep the status line
        }

        throw new ApiError(message, res.status, code);
    }

    return (await res.json()) as T;
}

function body(data: unknown): RequestInit {
    return { body: SafeJSON.stringify(data) };
}

export const apiClient = {
    overview: () => api<Overview>("/overview"),
    listWatchers: () => api<{ watchers: WatcherSummary[] }>("/watchers"),
    getWatcher: (id: number) => api<{ watcher: WatcherSummary }>(`/watchers/${id}`),
    createWatcher: (input: WatcherInput) => api<{ watcher: Watcher }>("/watchers", { method: "POST", ...body(input) }),
    updateWatcher: (id: number, patch: WatcherPatch) =>
        api<{ watcher: Watcher }>(`/watchers/${id}`, { method: "PATCH", ...body(patch) }),
    deleteWatcher: (id: number) => api<{ ok: true }>(`/watchers/${id}`, { method: "DELETE" }),
    runWatcher: (id: number) => api<RunResponse>(`/watchers/${id}/run`, { method: "POST" }),
    listChecks: (id: number, limit = 200) => api<{ checks: CheckRecord[] }>(`/watchers/${id}/checks?limit=${limit}`),
    listWatcherIncidents: (id: number) => api<{ incidents: IncidentWithWatcher[] }>(`/watchers/${id}/incidents`),
    listIncidents: (opts: { open?: boolean; limit?: number } = {}) =>
        api<{ incidents: IncidentWithWatcher[] }>(`/incidents?limit=${opts.limit ?? 100}${opts.open ? "&open=1" : ""}`),
    testCheck: (input: WatcherInput) => api<{ check: CheckResult }>("/check", { method: "POST", ...body(input) }),
    presets: () => api<{ presets: WatcherPreset[] }>("/presets"),
    aiAccounts: () => api<{ accounts: AiAccountOption[] }>("/ai-accounts"),
    notifySettings: () => api<{ settings: NotifySettings }>("/notifications"),
    sayVoices: () => api<{ providers: SayVoiceProvider[] }>("/say-voices"),
    updateNotifySettings: (patch: NotifySettingsPatch) =>
        api<{ settings: NotifySettings }>("/notifications", { method: "PATCH", ...body(patch) }),
    testNotification: (channel?: NotifyChannel) =>
        api<{ sent: true; channels: string[] }>(`/notifications/test${channel ? `?channel=${channel}` : ""}`, {
            method: "POST",
        }),
    listTargets: () => api<{ targets: NotifyTarget[] }>("/targets"),
    createTarget: (input: NotifyTargetInput) =>
        api<{ target: NotifyTarget }>("/targets", { method: "POST", ...body(input) }),
    updateTarget: (id: number, patch: NotifyTargetPatch) =>
        api<{ target: NotifyTarget }>(`/targets/${id}`, { method: "PATCH", ...body(patch) }),
    deleteTarget: (id: number) => api<{ ok: true }>(`/targets/${id}`, { method: "DELETE" }),
    testTarget: (id: number) => api<{ sent: true; target: NotifyTarget }>(`/targets/${id}/test`, { method: "POST" }),
    listFeedItems: (id: number, limit = 50) => api<{ items: FeedItem[] }>(`/watchers/${id}/items?limit=${limit}`),
    statuspageComponents: (target: string) =>
        api<{ page: string | null; components: Array<{ name: string; status: string }> }>("/statuspage/components", {
            method: "POST",
            ...body({ target }),
        }),
};
