import type { VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";
import type {
    Channel,
    ChannelHandle,
    JobStage,
    PipelineJob,
    SummaryFormat,
    SummaryLength,
    SummaryTone,
    TimestampedSummaryEntry,
    Transcript,
    Video,
    VideoComment,
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/types";
import { send } from "@ext/api.bridge";
import type { ExtensionApiMap } from "@ext/shared/messages";
import type { ExtensionConfig } from "@ext/shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useConfig() {
    return useQuery({
        queryKey: ["config"],
        queryFn: () => send<ExtensionConfig>({ type: "config:get" }),
    });
}

export function useChannels() {
    return useQuery({
        queryKey: ["channels"],
        queryFn: () => send<ExtensionApiMap["api:listChannels"]>({ type: "api:listChannels" }),
        select: (response) => response.channels,
    });
}

export function useChannelVideos(
    channel: ChannelHandle | null,
    opts: { limit?: number; includeShorts?: boolean } = {}
) {
    return useQuery({
        queryKey: ["videos", channel, opts.limit, opts.includeShorts],
        queryFn: () =>
            send<ExtensionApiMap["api:listVideos"]>({
                type: "api:listVideos",
                channel: channel as ChannelHandle,
                limit: opts.limit,
                includeShorts: opts.includeShorts,
            }),
        select: (response) => response.videos,
        enabled: channel !== null,
    });
}

export function useAddChannel() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (handle: ChannelHandle) =>
            send<ExtensionApiMap["api:addChannel"]>({ type: "api:addChannel", handle }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels"] }),
    });
}

export function useVideo(id: VideoId | null) {
    return useQuery({
        queryKey: ["video", id],
        queryFn: () => send<{ video: Video; transcripts: Transcript[] }>({ type: "api:getVideo", id: id as VideoId }),
        enabled: id !== null,
    });
}

export function useTranscript(id: VideoId | null, opts: { lang?: string; source?: "captions" | "ai" } = {}) {
    return useQuery({
        queryKey: ["transcript", id, opts.lang, opts.source],
        queryFn: () =>
            send<{ transcript: Transcript }>({
                type: "api:getTranscript",
                id: id as VideoId,
                lang: opts.lang,
                source: opts.source,
            }),
        enabled: id !== null,
    });
}

export function useComments(id: VideoId | null) {
    return useQuery({
        queryKey: ["comments", id],
        queryFn: () => send<{ comments: VideoComment[] }>({ type: "api:getComments", id: id as VideoId }),
        enabled: id !== null,
    });
}

export function useSummary(id: VideoId | null, mode: "short" | "timestamped" | "long") {
    return useQuery({
        queryKey: ["summary", id, mode],
        queryFn: async () => {
            const response = await send<ExtensionApiMap["api:getSummary"]>({
                type: "api:getSummary",
                id: id as VideoId,
                mode,
            });
            const cached = response.cached ?? false;

            if (mode === "long") {
                return { long: (response.summary ?? null) as VideoLongSummary | null, cached };
            }

            if (mode === "timestamped") {
                return { timestamped: (response.summary ?? []) as TimestampedSummaryEntry[], cached };
            }

            return { short: (response.summary ?? "") as string, cached };
        },
        enabled: id !== null,
    });
}

export function useGenerateSummary(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (opts: {
            mode: "short" | "timestamped" | "long";
            force?: boolean;
            provider?: string;
            model?: string;
            targetBins?: number;
            tone?: SummaryTone;
            format?: SummaryFormat;
            length?: SummaryLength;
        }) => {
            const response = await send<ExtensionApiMap["api:generateSummary"]>({
                type: "api:generateSummary",
                id,
                ...opts,
            });
            const cached = response.cached ?? false;

            if (opts.mode === "long") {
                return { long: (response.summary ?? null) as VideoLongSummary | null, cached, jobId: response.jobId };
            }

            if (opts.mode === "timestamped") {
                return {
                    timestamped: (response.summary ?? []) as TimestampedSummaryEntry[],
                    cached,
                    jobId: response.jobId,
                };
            }

            return { short: (response.summary ?? "") as string, cached, jobId: response.jobId };
        },
        onSuccess: (_data, opts) => {
            queryClient.invalidateQueries({ queryKey: ["summary", id, opts.mode] });
            queryClient.invalidateQueries({ queryKey: ["video", id] });
            queryClient.invalidateQueries({ queryKey: ["me"] });
        },
    });
}

export function useAskVideo(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { question: string; topK?: number; provider?: string; model?: string }) =>
            send<ExtensionApiMap["api:askVideo"]>({ type: "api:askVideo", id, ...vars }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["me"] });
            queryClient.invalidateQueries({ queryKey: ["qaHistory", id] });
        },
    });
}

export function useMe(enabled = true) {
    return useQuery({
        queryKey: ["me"],
        queryFn: () => send<ExtensionApiMap["api:me"]>({ type: "api:me" }),
        retry: false,
        enabled,
    });
}

export function useRegister() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { email: string; password: string }) =>
            send<ExtensionApiMap["api:register"]>({ type: "api:register", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
}

export function useLogin() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { email: string; password: string }) =>
            send<ExtensionApiMap["api:login"]>({ type: "api:login", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
}

export function useLogout() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => send<ExtensionApiMap["api:logout"]>({ type: "api:logout" }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["me"] });
            queryClient.invalidateQueries({ queryKey: ["qaHistory"] });
        },
    });
}

export function useTopup() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { amount?: number } = {}) =>
            send<ExtensionApiMap["api:topup"]>({ type: "api:topup", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
}

export function useQaHistory(id: VideoId | null) {
    return useQuery({
        queryKey: ["qaHistory", id],
        queryFn: () => send<ExtensionApiMap["api:qaHistory"]>({ type: "api:qaHistory", id: id ?? undefined }),
        retry: false,
        enabled: id !== null,
    });
}

export function useStartPipeline() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }) =>
            send<{ job: PipelineJob }>({ type: "api:startPipeline", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    });
}

export function useEstimate(
    id: VideoId | null,
    opts: { mode: "short" | "timestamped" | "long"; provider?: string; model?: string; enabled?: boolean }
) {
    return useQuery({
        queryKey: ["estimate", id, opts.mode, opts.provider, opts.model],
        queryFn: () =>
            send<ExtensionApiMap["api:estimate"]>({
                type: "api:estimate",
                id: id as VideoId,
                mode: opts.mode,
                provider: opts.provider,
                model: opts.model,
            }),
        staleTime: 60_000,
        enabled: id !== null && opts.enabled !== false,
    });
}

export function useModels(enabled = true) {
    return useQuery({
        queryKey: ["models"],
        queryFn: () => send<ExtensionApiMap["api:listModels"]>({ type: "api:listModels" }),
        staleTime: 60_000,
        enabled,
    });
}

export function useJob(id: number | null) {
    return useQuery({
        queryKey: ["job", id],
        queryFn: () => send<{ job: PipelineJob }>({ type: "api:getJob", id: id as number }),
        enabled: id !== null,
    });
}

export const dataSource: VideoDetailDataSource = {
    useVideo,
    useTranscript,
    useComments,
    useSummary,
    useGenerateSummary,
    useAskVideo,
    useEstimate,
    useQaHistory,
};

export type { Channel };
