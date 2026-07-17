import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type { ChannelHandle, CollectionKind, JobStage, JobStatus, QaSource, VideoId } from "@app/youtube/lib/types";
import { mergeUserSettings, resolveUserSettings, type UserSettings } from "@app/youtube/lib/user-settings";
import { apiClient, clearApiBaseUrlCache, setUserToken } from "@app/yt/api.client";
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
        onError: (error) => {
            toast.error("Adding channels failed", { description: errorMessage(error) });
        },
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
        onError: (error) => {
            toast.error("Removing channel failed", { description: errorMessage(error) });
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
        onError: (error) => {
            toast.error("Sync failed", { description: errorMessage(error) });
        },
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

export function useComments(id: VideoId | null) {
    return useQuery({
        queryKey: ["comments", id],
        queryFn: () => apiClient.getComments(id as VideoId),
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
        mutationFn: (vars: {
            question: string;
            topK?: number;
            provider?: string;
            model?: string;
            sources?: QaSource[];
            scope?: "video" | "channel";
        }) => apiClient.askVideo(id, vars),
    });
}

export function useSetSpeakers(id: VideoId) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (vars: { speakers: Array<{ idx: number; label: string }> }) =>
            apiClient.setSpeakers(id, vars.speakers),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["transcript", id] });
        },
        onError: (error) => {
            toast.error("Renaming speaker failed", { description: errorMessage(error) });
        },
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
        onError: (error) => {
            toast.error("Cancelling job failed", { description: errorMessage(error) });
        },
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
        onError: (error) => {
            toast.error("Prune failed", { description: errorMessage(error) });
        },
    });
}

export function useClearCache() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (body: { audio?: boolean; video?: boolean; thumbs?: boolean; all?: boolean }) =>
            apiClient.clearCache(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cache-stats"] }),
        onError: (error) => {
            toast.error("Clearing cache failed", { description: errorMessage(error) });
        },
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
        onError: (error) => {
            toast.error("Saving settings failed", { description: errorMessage(error) });
        },
    });
}

export function useMe() {
    return useQuery({ queryKey: ["me"], queryFn: () => apiClient.me(), retry: false });
}

export function useUserSettings() {
    const queryClient = useQueryClient();

    return useQuery({
        queryKey: ["userSettings"],
        queryFn: async () => (await apiClient.getSettings()).settings,
        // Seed from the /users/me cache so the panel renders without a flash.
        initialData: () => {
            const me = queryClient.getQueryData<{ settings?: UserSettings }>(["me"]);

            return me?.settings ? resolveUserSettings(me.settings) : undefined;
        },
        retry: false,
    });
}

export function useUpdateUserSettings() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (patch: Partial<UserSettings>) => apiClient.updateSettings(patch),
        // Optimistic: apply the merged patch locally, roll back on error.
        onMutate: async (patch) => {
            await queryClient.cancelQueries({ queryKey: ["userSettings"] });
            const previous = queryClient.getQueryData<UserSettings>(["userSettings"]);
            const base = previous ?? resolveUserSettings(null);
            queryClient.setQueryData(["userSettings"], mergeUserSettings(base, patch));

            return { previous };
        },
        onError: (error, _patch, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["userSettings"], context.previous);
            }

            toast.error("Couldn't save settings", { description: errorMessage(error) });
        },
        onSuccess: (data) => {
            queryClient.setQueryData(["userSettings"], data.settings);
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["me"] });
        },
    });
}

export function useLogin() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (vars: { email: string; password: string }) => {
            const result = await apiClient.login(vars.email, vars.password);
            setUserToken(result.token);

            return result;
        },
        onSuccess: () => queryClient.invalidateQueries(),
    });
}

export function useRegister() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (vars: { email: string; password: string }) => {
            const result = await apiClient.register(vars.email, vars.password);
            setUserToken(result.token);

            return result;
        },
        onSuccess: () => queryClient.invalidateQueries(),
    });
}

export function useLogout() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async () => {
            setUserToken(null);
        },
        onSuccess: () => queryClient.invalidateQueries(),
    });
}

export function useCollections() {
    return useQuery({
        queryKey: ["collections"],
        queryFn: () => apiClient.listCollections(),
        select: (response) => response.collections,
    });
}

export function useCollection(id: number | null) {
    return useQuery({
        queryKey: ["collection", id],
        queryFn: () => apiClient.getCollection(id as number),
        enabled: id !== null,
    });
}

export function useCreateCollection() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (body: { name: string; kind: CollectionKind; rule?: unknown }) => apiClient.createCollection(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["collections"] }),
        onError: (error) => {
            toast.error("Creating collection failed", { description: errorMessage(error) });
        },
    });
}

export function useDeleteCollection() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteCollection(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["collections"] }),
        onError: (error) => {
            toast.error("Deleting collection failed", { description: errorMessage(error) });
        },
    });
}

export function useAddCollectionVideo(id: number) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (videoId: string) => apiClient.addCollectionVideo(id, videoId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["collection", id] }),
        onError: (error) => {
            toast.error("Adding video failed", { description: errorMessage(error) });
        },
    });
}

export function useRemoveCollectionVideo(id: number) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (videoId: string) => apiClient.removeCollectionVideo(id, videoId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["collection", id] }),
        onError: (error) => {
            toast.error("Removing video failed", { description: errorMessage(error) });
        },
    });
}

export function useThreads(id: number | null) {
    return useQuery({
        queryKey: ["threads", id],
        queryFn: () => apiClient.listThreads(id as number),
        enabled: id !== null,
        select: (response) => response.threads,
    });
}

export function useThread(threadId: number | null) {
    return useQuery({
        queryKey: ["thread", threadId],
        queryFn: () => apiClient.getThread(threadId as number),
        enabled: threadId !== null,
    });
}

export function useAskCollection(id: number) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (body: { question: string; threadId?: number; provider?: string; model?: string }) =>
            apiClient.askCollection(id, body),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ["threads", id] });
            queryClient.invalidateQueries({ queryKey: ["thread", result.threadId] });
        },
        onError: (error) => {
            toast.error("Ask failed", { description: errorMessage(error) });
        },
    });
}

export function useHistory(groupBy: "video" | "action") {
    return useQuery({
        queryKey: ["history", groupBy],
        queryFn: () => apiClient.getHistory(groupBy),
    });
}

export function useWatchlist() {
    return useQuery({
        queryKey: ["watchlist"],
        queryFn: () => apiClient.getWatchlist(),
        select: (response) => response.channels,
    });
}

export function useToggleWatchlist() {
    const queryClient = useQueryClient();

    return useMutation<{ added: boolean } | { removed: boolean }, Error, { handle: string; follow: boolean }>({
        mutationFn: (vars) =>
            vars.follow ? apiClient.addWatchlistChannel(vars.handle) : apiClient.removeWatchlistChannel(vars.handle),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["watchlist"] });
            queryClient.invalidateQueries({ queryKey: ["digest"] });
        },
        onError: (error) => {
            toast.error("Updating watchlist failed", { description: errorMessage(error) });
        },
    });
}

export function useDigest(sinceDays: number) {
    return useQuery({
        queryKey: ["digest", sinceDays],
        queryFn: () => apiClient.getDigest(sinceDays),
    });
}

export function useDigestSync() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => apiClient.syncDigest(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["digest"] }),
        onError: (error) => {
            toast.error("Sync failed", { description: errorMessage(error) });
        },
    });
}
