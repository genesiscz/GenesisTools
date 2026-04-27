import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type { ChannelHandle, JobStage, JobStatus, VideoId } from "@app/youtube/lib/types";
import { apiClient, clearApiBaseUrlCache } from "@app/yt/api.client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export function useChannels() {
    return useQuery({
        queryKey: ["channels"],
        queryFn: () => apiClient.listChannels(),
        select: (response) => response.channels,
    });
}

export function useAddChannels() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (handles: string[]) => apiClient.addChannels(handles),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels"] }),
    });
}

export function useRemoveChannel() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (handle: ChannelHandle) => apiClient.removeChannel(handle),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["channels"] });
            queryClient.invalidateQueries({ queryKey: ["videos"] });
        },
    });
}

export function useSyncChannel() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (args: { handle: ChannelHandle; limit?: number; includeShorts?: boolean; since?: string }) =>
            apiClient.syncChannel(args.handle, {
                limit: args.limit,
                includeShorts: args.includeShorts,
                since: args.since,
            }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    });
}

export function useVideos(params: Parameters<typeof apiClient.listVideos>[0] = {}) {
    return useQuery({
        queryKey: ["videos", params],
        queryFn: () => apiClient.listVideos(params),
        select: (response) => response.videos,
    });
}

export function useVideo(id: VideoId | null) {
    return useQuery({
        queryKey: ["video", id],
        queryFn: () => apiClient.getVideo(id as VideoId),
        enabled: id !== null,
    });
}

export function useTranscript(id: VideoId | null, opts: { lang?: string; source?: "captions" | "ai" } = {}) {
    return useQuery({
        queryKey: ["transcript", id, opts.lang, opts.source],
        queryFn: () => apiClient.getTranscript(id as VideoId, opts),
        enabled: id !== null,
    });
}

export function useSummary(id: VideoId | null, mode: "short" | "timestamped" | "long") {
    return useQuery({
        queryKey: ["summary", id, mode],
        queryFn: () => apiClient.getSummary(id as VideoId, mode),
        enabled: id !== null,
    });
}

export function useGenerateSummary(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (opts: {
            mode: "short" | "timestamped" | "long";
            force?: boolean;
            provider?: string;
            model?: string;
            targetBins?: number;
            tone?: "insightful" | "funny" | "actionable" | "controversial";
            format?: "list" | "qa";
            length?: "short" | "auto" | "detailed";
        }) => apiClient.generateSummary(id, opts),
        onSuccess: (_data, opts) => {
            queryClient.invalidateQueries({ queryKey: ["summary", id, opts.mode] });
            queryClient.invalidateQueries({ queryKey: ["video", id] });
            queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
        onError: (error, opts) => {
            toast.error(`Generate ${opts.mode} summary failed`, { description: errorMessage(error) });
        },
    });
}

export function useAskVideo(id: VideoId) {
    return useMutation({
        mutationFn: (vars: { question: string; topK?: number; provider?: string; model?: string }) =>
            apiClient.askVideo(id, vars),
    });
}

export function useJobs(params: { status?: JobStatus; limit?: number } = {}) {
    return useQuery({
        queryKey: ["jobs", params],
        queryFn: () => apiClient.listJobs(params),
        select: (response) => response.jobs,
        refetchInterval: 5000,
    });
}

export function useJob(id: number | null) {
    return useQuery({
        queryKey: ["job", id],
        queryFn: () => apiClient.getJob(id as number),
        enabled: id !== null,
    });
}

export function useJobActivity(id: number | null, opts: { refetchInterval?: number } = {}) {
    return useQuery({
        queryKey: ["job-activity", id],
        queryFn: () => apiClient.getJobActivity(id as number),
        enabled: id !== null,
        refetchInterval: opts.refetchInterval ?? 3000,
        select: (response) => response.activity,
    });
}

export function useCancelJob() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiClient.cancelJob(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    });
}

export function useStartPipeline() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }) =>
            apiClient.startPipeline(vars),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    });
}

export function useCacheStats() {
    return useQuery({ queryKey: ["cache-stats"], queryFn: () => apiClient.getCacheStats() });
}

export function usePruneCache() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (dryRun: boolean) => apiClient.pruneCache(dryRun),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cache-stats"] }),
    });
}

export function useClearCache() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (body: { audio?: boolean; video?: boolean; thumbs?: boolean; all?: boolean }) =>
            apiClient.clearCache(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cache-stats"] }),
    });
}

export function useServerConfig() {
    return useQuery({ queryKey: ["server-config"], queryFn: () => apiClient.getConfig() });
}

export function usePatchServerConfig() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (patch: YoutubeConfigPatch) => apiClient.patchConfig(patch),
        onSuccess: () => {
            clearApiBaseUrlCache();
            queryClient.invalidateQueries({ queryKey: ["server-config"] });
            queryClient.invalidateQueries({ queryKey: ["cache-stats"] });
        },
    });
}
