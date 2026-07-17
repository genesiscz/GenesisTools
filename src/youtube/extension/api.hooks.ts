import type { VideoDetailDataSource } from "@app/utils/ui/components/youtube/tabs";
import type {
    Channel,
    ChannelHandle,
    JobStage,
    PipelineJob,
    QaSource,
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
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

/** Stop polling a still-generating report after this long and tell the user to check the dashboard. */
const REPORT_POLL_TIMEOUT_MS = 10 * 60_000;

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
            send<ExtensionApiMap["api:getTranscript"]>({
                type: "api:getTranscript",
                id: id as VideoId,
                lang: opts.lang,
                source: opts.source,
            }),
        enabled: id !== null,
    });
}

export function useTranslateTranscript(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { lang: string }) =>
            send<ExtensionApiMap["api:translateTranscript"]>({ type: "api:translateTranscript", id, ...vars }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["transcript", id] });
            queryClient.invalidateQueries({ queryKey: ["video", id] });
            queryClient.invalidateQueries({ queryKey: ["me"] });
        },
    });
}

export function useGenerateSummaryAudio(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { voice?: string } = {}) =>
            send<ExtensionApiMap["api:generateSummaryAudio"]>({ type: "api:generateSummaryAudio", id, ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
}

/** Turns the relative `url` a `generateSummaryAudio` response returns into a fetchable, authenticated URL for `<audio src>` — the element can't send an Authorization header, so the token travels as `?token=`. */
export function buildAudioSrc(
    relativeUrl: string,
    config: { apiBaseUrl: string; userToken?: string; serviceKey?: string }
): string {
    const base = config.apiBaseUrl.replace(/\/$/, "");
    const token = config.userToken ?? config.serviceKey ?? "";
    const separator = relativeUrl.includes("?") ? "&" : "?";

    return `${base}${relativeUrl}${separator}token=${encodeURIComponent(token)}`;
}

export function usePatchMe() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { outputLang?: string; ttsVoice?: string }) =>
            send<ExtensionApiMap["api:patchMe"]>({ type: "api:patchMe", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
}

export function useSetSpeakers(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { speakers: Array<{ idx: number; label: string }> }) =>
            send<ExtensionApiMap["api:setSpeakers"]>({ type: "api:setSpeakers", id, ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["transcript", id] }),
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

            if (response.locked) {
                return { locked: true as const, price: response.price, preview: response.preview };
            }

            const cached = response.cached ?? false;
            const lang = response.lang;

            if (mode === "long") {
                return { long: (response.summary ?? null) as VideoLongSummary | null, cached, lang };
            }

            if (mode === "timestamped") {
                return { timestamped: (response.summary ?? []) as TimestampedSummaryEntry[], cached, lang };
            }

            return { short: (response.summary ?? "") as string, cached, lang };
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
            presetId?: number;
            lang?: string;
        }) => {
            const response = await send<ExtensionApiMap["api:generateSummary"]>({
                type: "api:generateSummary",
                id,
                ...opts,
            });
            const cached = response.cached ?? false;
            const lang = response.lang;

            if (opts.mode === "long") {
                return {
                    long: (response.summary ?? null) as VideoLongSummary | null,
                    cached,
                    lang,
                    jobId: response.jobId,
                };
            }

            if (opts.mode === "timestamped") {
                return {
                    timestamped: (response.summary ?? []) as TimestampedSummaryEntry[],
                    cached,
                    lang,
                    jobId: response.jobId,
                };
            }

            return { short: (response.summary ?? "") as string, cached, lang, jobId: response.jobId };
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
        mutationFn: (vars: {
            question: string;
            topK?: number;
            provider?: string;
            model?: string;
            presetId?: number;
            sources?: QaSource[];
            scope?: "video" | "channel";
        }) => send<ExtensionApiMap["api:askVideo"]>({ type: "api:askVideo", id, ...vars }),
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
        // Returning from the Stripe checkout tab refocuses the panel — refetch
        // so the diamonds chip picks up the webhook-granted balance quickly.
        refetchOnWindowFocus: true,
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

export function useCheckout() {
    return useMutation({
        mutationFn: (vars: { packId: string }) =>
            send<ExtensionApiMap["api:checkout"]>({ type: "api:checkout", ...vars }),
    });
}

export function useLedger(enabled = true) {
    return useInfiniteQuery({
        queryKey: ["ledger"],
        queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
            send<ExtensionApiMap["api:ledger"]>({ type: "api:ledger", before: pageParam, limit: 50 }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
        enabled,
    });
}

export function useUsageSummary(enabled = true) {
    return useQuery({
        queryKey: ["usageSummary"],
        queryFn: () => send<ExtensionApiMap["api:usageSummary"]>({ type: "api:usageSummary" }),
        enabled,
    });
}

export function useCreateShare() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: {
            kind: "summary" | "qa";
            videoId: VideoId;
            mode?: "short" | "timestamped" | "long";
            qaHistoryId?: number;
        }) => send<ExtensionApiMap["api:createShare"]>({ type: "api:createShare", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shares"] }),
    });
}

export function useShares(enabled = true) {
    return useQuery({
        queryKey: ["shares"],
        queryFn: () => send<ExtensionApiMap["api:listShares"]>({ type: "api:listShares" }),
        select: (response) => response.shares,
        enabled,
    });
}

export function useRevokeShare() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { slug: string }) =>
            send<ExtensionApiMap["api:revokeShare"]>({ type: "api:revokeShare", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shares"] }),
    });
}

export function useListPresets(kind?: "summary" | "insights" | "ask", enabled = true) {
    return useQuery({
        queryKey: ["presets", kind],
        queryFn: () => send<ExtensionApiMap["api:listPresets"]>({ type: "api:listPresets", kind }),
        select: (response) => response.presets,
        enabled,
    });
}

export function useCreatePreset() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { name: string; kind: "summary" | "insights" | "ask"; instructions: string }) =>
            send<ExtensionApiMap["api:createPreset"]>({ type: "api:createPreset", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["presets"] }),
    });
}

export function useUpdatePreset() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { id: number; name?: string; instructions?: string }) =>
            send<ExtensionApiMap["api:updatePreset"]>({ type: "api:updatePreset", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["presets"] }),
    });
}

export function useDeletePreset() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { id: number }) =>
            send<ExtensionApiMap["api:deletePreset"]>({ type: "api:deletePreset", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["presets"] }),
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

export function useReportEstimate(videoIds: string[], enabled: boolean) {
    return useQuery({
        queryKey: ["report-estimate", videoIds],
        queryFn: () => send<ExtensionApiMap["api:reportEstimate"]>({ type: "api:reportEstimate", videoIds }),
        staleTime: 30_000,
        enabled: enabled && videoIds.length >= 2,
    });
}

export function useCreateReport() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { videoIds: string[]; title?: string }) =>
            send<ExtensionApiMap["api:createReport"]>({ type: "api:createReport", ...vars }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
    });
}

export function useReport(id: number | null) {
    // When polling began for the current report — bounds how long we poll a
    // job that never finishes.
    const pollStartRef = useRef<number | null>(null);

    if (id === null) {
        pollStartRef.current = null;
    } else if (pollStartRef.current === null) {
        pollStartRef.current = Date.now();
    }

    const query = useQuery({
        queryKey: ["report", id],
        queryFn: () => send<ExtensionApiMap["api:getReport"]>({ type: "api:getReport", id: id as number }),
        enabled: id !== null,
        // Poll while the report is still being generated, but give up after the
        // timeout so a stuck job doesn't poll forever.
        refetchInterval: (query) => {
            if (query.state.data?.report.result) {
                return false;
            }

            if (pollStartRef.current !== null && Date.now() - pollStartRef.current >= REPORT_POLL_TIMEOUT_MS) {
                return false;
            }

            return 3000;
        },
    });

    const pollTimedOut =
        id !== null &&
        query.data?.report.result == null &&
        pollStartRef.current !== null &&
        Date.now() - pollStartRef.current >= REPORT_POLL_TIMEOUT_MS;

    return { ...query, pollTimedOut };
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
    opts: {
        mode: "short" | "timestamped" | "long";
        provider?: string;
        model?: string;
        /** Feature 08: refetch the quote when the dialog's language selection changes. */
        lang?: string;
        enabled?: boolean;
    }
) {
    return useQuery({
        queryKey: ["estimate", id, opts.mode, opts.provider, opts.model, opts.lang],
        queryFn: () =>
            send<ExtensionApiMap["api:estimate"]>({
                type: "api:estimate",
                id: id as VideoId,
                mode: opts.mode,
                provider: opts.provider,
                model: opts.model,
                lang: opts.lang,
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
    useCreateShare,
    useListPresets,
    useCreatePreset,
    useSetSpeakers,
    useTranslateTranscript,
    useGenerateSummaryAudio: (id: VideoId) => {
        const mutation = useGenerateSummaryAudio(id);

        return {
            mutateAsync: (vars?: { voice?: string }) => mutation.mutateAsync(vars ?? {}),
            isPending: mutation.isPending,
            error: mutation.error,
        };
    },
};

export type { Channel };
