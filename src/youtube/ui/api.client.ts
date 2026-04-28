import { SafeJSON } from "@app/utils/json";
import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type {
    Channel,
    ChannelHandle,
    JobActivity,
    JobStage,
    JobStatus,
    PipelineJob,
    TimestampedSummaryEntry,
    Transcript,
    Video,
    VideoId,
    VideoLongSummary,
    YoutubeConfigShape,
} from "@app/youtube/lib/types";
import { fetchUiConfig } from "@app/yt/config.client";

export interface AskVideoResponse {
    answer: string;
    citations: Array<{ videoId: string; chunkIdx: number; startSec: number | null; endSec: number | null }>;
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

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = await baseUrl();
    const res = await fetch(`${base}/api/v1${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

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
        api<{ transcript: Transcript }>(
            withQuery(`/videos/${encodeURIComponent(id)}/transcript`, [
                ["lang", opts.lang],
                ["source", opts.source],
            ])
        ),
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
    askVideo: (id: VideoId, opts: { question: string; topK?: number; provider?: string; model?: string }) =>
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
};
