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
    VideoId,
    VideoLongSummary,
} from "@app/youtube/lib/types";
import { send } from "@ext/api.bridge";
import type { ExtensionApiMap } from "@ext/shared/messages";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useChannels() {
    return useQuery({
        queryKey: ["channels"],
        queryFn: () => send<ExtensionApiMap["api:listChannels"]>({ type: "api:listChannels" }),
        select: (response) => response.channels,
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

export function useSummary(id: VideoId | null, mode: "short" | "timestamped" | "long") {
    return useQuery({
        queryKey: ["summary", id, mode],
        queryFn: async () => {
            if (mode === "long") {
                return { long: null as VideoLongSummary | null, cached: false };
            }

            const response = await send<ExtensionApiMap["api:getSummary"]>({
                type: "api:getSummary",
                id: id as VideoId,
                mode,
            });

            if (mode === "timestamped") {
                return {
                    timestamped: (response.summary ?? []) as TimestampedSummaryEntry[],
                    cached: response.cached ?? false,
                };
            }

            return { short: (response.summary ?? "") as string, cached: response.cached ?? false };
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
            if (opts.mode === "long") {
                return { long: null as VideoLongSummary | null, cached: false };
            }

            const { tone: _tone, format: _format, length: _length, ...bridgeOpts } = opts;
            const response = await send<ExtensionApiMap["api:generateSummary"]>({
                type: "api:generateSummary",
                id,
                ...bridgeOpts,
                mode: bridgeOpts.mode as "short" | "timestamped",
            });

            if (opts.mode === "timestamped") {
                return {
                    timestamped: (response.summary ?? []) as TimestampedSummaryEntry[],
                    cached: response.cached ?? false,
                };
            }

            return { short: (response.summary ?? "") as string, cached: response.cached ?? false };
        },
        onSuccess: (_data, opts) => {
            queryClient.invalidateQueries({ queryKey: ["summary", id, opts.mode] });
            queryClient.invalidateQueries({ queryKey: ["video", id] });
        },
    });
}

export function useAskVideo(id: VideoId) {
    return useMutation({
        mutationFn: (vars: { question: string; topK?: number; provider?: string; model?: string }) =>
            send<ExtensionApiMap["api:askVideo"]>({ type: "api:askVideo", id, ...vars }),
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
    useSummary,
    useGenerateSummary,
    useAskVideo,
};

export type { Channel };
