import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { send } from "@ext/api.bridge";
import type { ExtensionApiMap } from "@ext/shared/messages";
import type { Channel, ChannelHandle, JobStage, PipelineJob, TimestampedSummaryEntry, Transcript, Video, VideoId } from "@app/youtube/lib/types";
import type { VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";

export function useChannels() {
    return useQuery({ queryKey: ["channels"], queryFn: () => send<ExtensionApiMap["api:listChannels"]>({ type: "api:listChannels" }), select: (response) => response.channels });
}

export function useAddChannel() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (handle: ChannelHandle) => send<ExtensionApiMap["api:addChannel"]>({ type: "api:addChannel", handle }),
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
        queryFn: () => send<{ transcript: Transcript }>({ type: "api:getTranscript", id: id as VideoId, lang: opts.lang, source: opts.source }),
        enabled: id !== null,
    });
}

export function useSummary(id: VideoId | null, mode: "short" | "timestamped") {
    return useQuery({
        queryKey: ["summary", id, mode],
        queryFn: async () => {
            const response = await send<{ summary?: string | TimestampedSummaryEntry[]; short?: string; timestamped?: TimestampedSummaryEntry[] }>({ type: "api:getSummary", id: id as VideoId, mode });

            if (mode === "timestamped") {
                return { timestamped: (response.timestamped ?? response.summary ?? []) as TimestampedSummaryEntry[] };
            }

            return { short: (response.short ?? response.summary ?? "") as string };
        },
        enabled: id !== null,
    });
}

export function useAskVideo(id: VideoId) {
    return useMutation({
        mutationFn: (vars: { question: string; topK?: number }) => send<ExtensionApiMap["api:askVideo"]>({ type: "api:askVideo", id, question: vars.question, topK: vars.topK }),
    });
}

export function useStartPipeline() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { target: string; targetKind?: "video" | "channel" | "url"; stages: JobStage[] }) => send<{ job: PipelineJob }>({ type: "api:startPipeline", ...vars }),
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
    useAskVideo,
};

export type { Channel };
