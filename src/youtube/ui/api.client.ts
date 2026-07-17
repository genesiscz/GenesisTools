import { SafeJSON } from "@app/utils/json";
import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type {
    ActionHistoryGroup,
    AskCitation,
    AskMessageRecord,
    AskThreadRecord,
    Channel,
    ChannelHandle,
    CollectionKind,
    CollectionRecord,
    JobActivity,
    JobStage,
    JobStatus,
    PipelineJob,
    QaSource,
    TimestampedSummaryEntry,
    Transcript,
    Video,
    VideoComment,
    VideoHistoryGroup,
    VideoId,
    VideoLite,
    VideoLongSummary,
    WatchlistEntry,
    YoutubeConfigShape,
    YtUser,
} from "@app/youtube/lib/types";
import type { UserSettings } from "@app/youtube/lib/user-settings";
import { fetchUiConfig } from "@app/yt/config.client";
import { reportBackendReachable, reportBackendUnreachable } from "./backend-status";

export interface AskVideoResponse {
    answer: string;
    citations: AskCitation[];
}

export interface CacheStatsResponse {
    channels: number;
    videos: number;
    transcripts: number | { n: number };
    jobs: PipelineJob[] | Array<{ status: string; n: number }>;
    audioBytes: number | { n: number };
    videoBytes: number | { n: number };
    thumbBytes?: number | { n: number };
}

export interface CollectionAskResponse {
    threadId: number;
    answer: string;
    toolCalls: number;
    creditsSpent: number;
    credits: number;
}

export interface HistoryResponse {
    groupBy: "video" | "action";
    videos?: VideoHistoryGroup[];
    actions?: ActionHistoryGroup[];
    videosById: Record<string, VideoLite>;
}

export interface DigestResponse {
    since: string;
    channels: Array<{ handle: string; videos: VideoLite[] }>;
}

let cachedBase: string | null = null;

export function clearApiBaseUrlCache(): void {
    cachedBase = null;
}

async function baseUrl(): Promise<string> {
    if (cachedBase) {
        return cachedBase;
    }

    const { config } = await fetchUiConfig();
    cachedBase = config.apiBaseUrl.replace(/\/$/, "");

    return cachedBase;
}

const USER_TOKEN_STORAGE_KEY = "yt.userToken";

export function getUserToken(): string | null {
    if (typeof localStorage === "undefined") {
        return null;
    }

    return localStorage.getItem(USER_TOKEN_STORAGE_KEY);
}

export function setUserToken(token: string | null): void {
    if (typeof localStorage === "undefined") {
        return;
    }

    if (token) {
        localStorage.setItem(USER_TOKEN_STORAGE_KEY, token);
    } else {
        localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
    }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = await baseUrl();
    const token = getUserToken();
    let res: Response;

    try {
        res = await fetch(`${base}/api/v1${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(init.headers ?? {}),
            },
        });
    } catch (err) {
        // Network-level failure (ERR_CONNECTION_REFUSED etc.) — the backend is down,
        // not "the database is empty". Surface it instead of failing silently.
        reportBackendUnreachable(`${base} is not responding`);
        throw new Error(`YouTube API server unreachable at ${base}. Start it with: tools youtube server up`, {
            cause: err,
        });
    }

    reportBackendReachable();

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }

    return (await res.json()) as T;
}

function withQuery(path: string, values: Array<[string, string | number | boolean | undefined]>): string {
    const params = new URLSearchParams();

    for (const [key, value] of values) {
        if (value !== undefined && value !== false && value !== "") {
            params.set(key, String(value));
        }
    }

    const query = params.toString();

    if (!query) {
        return path;
    }

    return `${path}?${query}`;
}

export const apiClient = {
    listChannels: () => api<{ channels: Channel[] }>("/channels"),
    addChannels: (handles: string[]) =>
        api<{ added: ChannelHandle[] }>("/channels", { method: "POST", body: SafeJSON.stringify({ handles }) }),
    removeChannel: (handle: ChannelHandle) =>
        api<{ removed: ChannelHandle }>(`/channels/${encodeURIComponent(handle)}`, { method: "DELETE" }),
    syncChannel: (handle: ChannelHandle, _body: { limit?: number; includeShorts?: boolean; since?: string } = {}) =>
        api<{ enqueuedJobId: number; enqueuedJobIds?: number[] }>(`/channels/${encodeURIComponent(handle)}/sync`, {
            method: "POST",
            body: SafeJSON.stringify(_body),
        }),
    listVideos: (params: { channel?: ChannelHandle; since?: string; limit?: number; includeShorts?: boolean } = {}) =>
        api<{ videos: Video[] }>(
            withQuery("/videos", [
                ["channel", params.channel],
                ["since", params.since],
                ["limit", params.limit],
                ["includeShorts", params.includeShorts],
            ])
        ),
    getVideo: (id: VideoId) => api<{ video: Video; transcripts: Transcript[] }>(`/videos/${encodeURIComponent(id)}`),
    getTranscript: (id: VideoId, opts: { lang?: string; source?: "captions" | "ai" } = {}) =>
        api<{ transcript: Transcript; speakerLabels?: Record<number, string> }>(
            withQuery(`/videos/${encodeURIComponent(id)}/transcript`, [
                ["lang", opts.lang],
                ["source", opts.source],
            ])
        ),
    setSpeakers: (id: VideoId, speakers: Array<{ idx: number; label: string }>) =>
        api<{ speakerLabels: Record<number, string> }>(`/videos/${encodeURIComponent(id)}/speakers`, {
            method: "PUT",
            body: SafeJSON.stringify({ speakers }),
        }),
    getComments: (id: VideoId) => api<{ comments: VideoComment[] }>(`/videos/${encodeURIComponent(id)}/comments`),
    getSummary: async (id: VideoId, mode: "short" | "timestamped" | "long") => {
        const response = await api<{
            summary?: string | TimestampedSummaryEntry[] | VideoLongSummary | null;
            mode?: "short" | "timestamped" | "long";
            cached?: boolean;
        }>(withQuery(`/videos/${encodeURIComponent(id)}/summary`, [["mode", mode]]));

        if (mode === "timestamped") {
            return {
                timestamped: (response.summary ?? []) as TimestampedSummaryEntry[],
                cached: response.cached ?? false,
            };
        }

        if (mode === "long") {
            return {
                long: (response.summary ?? null) as VideoLongSummary | null,
                cached: response.cached ?? false,
            };
        }

        return { short: (response.summary ?? "") as string, cached: response.cached ?? false };
    },
    generateSummary: async (
        id: VideoId,
        opts: {
            mode: "short" | "timestamped" | "long";
            force?: boolean;
            provider?: string;
            model?: string;
            targetBins?: number;
            tone?: "insightful" | "funny" | "actionable" | "controversial";
            format?: "list" | "qa";
            length?: "short" | "auto" | "detailed";
        }
    ) => {
        const response = await api<{
            summary: string | TimestampedSummaryEntry[] | VideoLongSummary | null;
            mode: "short" | "timestamped" | "long";
            cached: boolean;
            jobId?: number;
        }>(`/videos/${encodeURIComponent(id)}/summary`, { method: "POST", body: SafeJSON.stringify(opts) });

        if (opts.mode === "timestamped") {
            return {
                timestamped: (response.summary ?? []) as TimestampedSummaryEntry[],
                cached: response.cached,
                jobId: response.jobId,
            };
        }

        if (opts.mode === "long") {
            return {
                long: (response.summary ?? null) as VideoLongSummary | null,
                cached: response.cached,
                jobId: response.jobId,
            };
        }

        return { short: (response.summary ?? "") as string, cached: response.cached, jobId: response.jobId };
    },
    askVideo: (
        id: VideoId,
        opts: {
            question: string;
            topK?: number;
            provider?: string;
            model?: string;
            sources?: QaSource[];
            scope?: "video" | "channel";
        }
    ) =>
        api<AskVideoResponse>(`/videos/${encodeURIComponent(id)}/qa`, {
            method: "POST",
            body: SafeJSON.stringify(opts),
        }),
    listJobs: (params: { status?: JobStatus; limit?: number } = {}) =>
        api<{ jobs: PipelineJob[] }>(
            withQuery("/jobs", [
                ["status", params.status],
                ["limit", params.limit],
            ])
        ),
    getJob: (id: number) => api<{ job: PipelineJob }>(`/jobs/${id}`),
    getJobActivity: (id: number) => api<{ activity: JobActivity[] }>(`/jobs/${id}/activity`),
    cancelJob: (id: number) => api<{ job: PipelineJob | null }>(`/jobs/${id}/cancel`, { method: "POST" }),
    startPipeline: (body: { target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }) =>
        api<{ job: PipelineJob }>("/pipeline", { method: "POST", body: SafeJSON.stringify(body) }),
    getCacheStats: () => api<CacheStatsResponse>("/cache/stats"),
    pruneCache: (dryRun: boolean) =>
        api<{ audio: number; video: number; thumb: number; dryRun?: boolean }>("/cache/prune", {
            method: "POST",
            body: SafeJSON.stringify({ dryRun }),
        }),
    clearCache: (body: { audio?: boolean; video?: boolean; thumbs?: boolean; all?: boolean }) =>
        api<{ deletedCount: number; freedBytes: number }>("/cache/clear", {
            method: "POST",
            body: SafeJSON.stringify(body),
        }),
    getConfig: () => api<{ config: YoutubeConfigShape; where: string }>("/config"),
    patchConfig: (patch: YoutubeConfigPatch) =>
        api<{ config: YoutubeConfigShape }>("/config", { method: "PATCH", body: SafeJSON.stringify(patch) }),
    health: () => api<{ ok?: boolean; status?: string }>("/healthz"),

    register: (email: string, password: string) =>
        api<{ user: YtUser; token: string }>("/users/register", {
            method: "POST",
            body: SafeJSON.stringify({ email, password }),
        }),
    login: (email: string, password: string) =>
        api<{ user: YtUser; token: string }>("/users/login", {
            method: "POST",
            body: SafeJSON.stringify({ email, password }),
        }),
    me: () => api<{ user: YtUser; role: string; settings: UserSettings }>("/users/me"),
    getSettings: () => api<{ settings: UserSettings }>("/users/settings"),
    updateSettings: (patch: Partial<UserSettings>) =>
        api<{ settings: UserSettings }>("/users/settings", { method: "PATCH", body: SafeJSON.stringify(patch) }),

    listCollections: () => api<{ collections: Array<CollectionRecord & { videoCount: number }> }>("/collections"),
    createCollection: (body: { name: string; kind: CollectionKind; rule?: unknown }) =>
        api<{ collection: CollectionRecord }>("/collections", { method: "POST", body: SafeJSON.stringify(body) }),
    getCollection: (id: number) => api<{ collection: CollectionRecord; videos: VideoLite[] }>(`/collections/${id}`),
    deleteCollection: (id: number) => api<{ deleted: boolean }>(`/collections/${id}`, { method: "DELETE" }),
    addCollectionVideo: (id: number, videoId: string) =>
        api<{ added: boolean }>(`/collections/${id}/videos`, { method: "POST", body: SafeJSON.stringify({ videoId }) }),
    removeCollectionVideo: (id: number, videoId: string) =>
        api<{ removed: boolean }>(`/collections/${id}/videos/${encodeURIComponent(videoId)}`, { method: "DELETE" }),
    askCollection: (id: number, body: { question: string; threadId?: number; provider?: string; model?: string }) =>
        api<CollectionAskResponse>(`/collections/${id}/ask`, { method: "POST", body: SafeJSON.stringify(body) }),
    listThreads: (id: number) => api<{ threads: AskThreadRecord[] }>(`/collections/${id}/threads`),
    getThread: (threadId: number) =>
        api<{ thread: AskThreadRecord; messages: AskMessageRecord[] }>(`/collections/threads/${threadId}`),

    getHistory: (groupBy: "video" | "action", limit?: number) =>
        api<HistoryResponse>(
            withQuery("/users/history", [
                ["groupBy", groupBy],
                ["limit", limit],
            ])
        ),

    getWatchlist: () => api<{ channels: WatchlistEntry[] }>("/users/watchlist"),
    addWatchlistChannel: (handle: string) =>
        api<{ added: boolean }>("/users/watchlist", { method: "POST", body: SafeJSON.stringify({ handle }) }),
    removeWatchlistChannel: (handle: string) =>
        api<{ removed: boolean }>(`/users/watchlist/${encodeURIComponent(handle)}`, { method: "DELETE" }),
    getDigest: (sinceDays?: number) => api<DigestResponse>(withQuery("/users/digest", [["sinceDays", sinceDays]])),
    syncDigest: () => api<{ enqueuedJobIds: number[] }>("/users/digest/sync", { method: "POST" }),
};
