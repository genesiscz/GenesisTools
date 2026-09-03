import type { NotifySettingsPatch } from "@app/monitor/lib/notify-settings";
import type {
    MonitorEvent,
    NotifyChannel,
    NotifyTargetInput,
    NotifyTargetPatch,
    WatcherInput,
    WatcherPatch,
} from "@app/monitor/lib/types";
import { apiClient } from "@app/monitor/ui/api.client";
import { useEventStream } from "@app/monitor/ui/ws.client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

export const queryKeys = {
    overview: ["overview"] as const,
    watcher: (id: number) => ["watcher", id] as const,
    checks: (id: number) => ["checks", id] as const,
    watcherIncidents: (id: number) => ["watcher-incidents", id] as const,
    incidents: (open: boolean) => ["incidents", open] as const,
    presets: ["presets"] as const,
    aiAccounts: ["ai-accounts"] as const,
    notify: ["notify-settings"] as const,
    targets: ["targets"] as const,
    feedItems: (id: number) => ["feed-items", id] as const,
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function useOverview() {
    return useQuery({ queryKey: queryKeys.overview, queryFn: () => apiClient.overview(), refetchInterval: 30_000 });
}

export function useWatcher(id: number) {
    return useQuery({
        queryKey: queryKeys.watcher(id),
        queryFn: () => apiClient.getWatcher(id),
        select: (response) => response.watcher,
    });
}

export function useChecks(id: number, limit = 200) {
    return useQuery({
        queryKey: [...queryKeys.checks(id), limit],
        queryFn: () => apiClient.listChecks(id, limit),
        select: (response) => response.checks,
    });
}

export function useWatcherIncidents(id: number) {
    return useQuery({
        queryKey: queryKeys.watcherIncidents(id),
        queryFn: () => apiClient.listWatcherIncidents(id),
        select: (response) => response.incidents,
    });
}

export function useIncidents(open: boolean) {
    return useQuery({
        queryKey: queryKeys.incidents(open),
        queryFn: () => apiClient.listIncidents({ open, limit: 200 }),
        select: (response) => response.incidents,
    });
}

export function usePresets() {
    return useQuery({
        queryKey: queryKeys.presets,
        queryFn: () => apiClient.presets(),
        select: (response) => response.presets,
        staleTime: Number.POSITIVE_INFINITY,
    });
}

export function useAiAccounts(enabled: boolean) {
    return useQuery({
        queryKey: queryKeys.aiAccounts,
        queryFn: () => apiClient.aiAccounts(),
        select: (response) => response.accounts,
        enabled,
    });
}

export function useSayVoices(enabled: boolean) {
    return useQuery({
        queryKey: ["say-voices"],
        queryFn: () => apiClient.sayVoices(),
        select: (response) => response.providers,
        staleTime: 5 * 60_000,
        enabled,
    });
}

export function useNotifySettings() {
    return useQuery({
        queryKey: queryKeys.notify,
        queryFn: () => apiClient.notifySettings(),
        select: (response) => response.settings,
    });
}

function useInvalidateWatchers() {
    const queryClient = useQueryClient();

    return (id?: number) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
        void queryClient.invalidateQueries({ queryKey: ["incidents"] });

        if (id !== undefined) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.watcher(id) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.checks(id) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.watcherIncidents(id) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.feedItems(id) });
        }
    };
}

export function useCreateWatcher() {
    const invalidate = useInvalidateWatchers();

    return useMutation({
        mutationFn: (input: WatcherInput) => apiClient.createWatcher(input),
        onSuccess: (response) => {
            invalidate();
            toast.success(`Watching "${response.watcher.name}"`);
        },
        onError: (error) => toast.error("Could not add watcher", { description: errorMessage(error) }),
    });
}

export function useUpdateWatcher() {
    const invalidate = useInvalidateWatchers();

    return useMutation({
        mutationFn: (args: { id: number; patch: WatcherPatch }) => apiClient.updateWatcher(args.id, args.patch),
        onSuccess: (_response, args) => invalidate(args.id),
        onError: (error) => toast.error("Could not update watcher", { description: errorMessage(error) }),
    });
}

export function useDeleteWatcher() {
    const invalidate = useInvalidateWatchers();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteWatcher(id),
        onSuccess: () => {
            invalidate();
            toast.success("Watcher deleted");
        },
        onError: (error) => toast.error("Could not delete watcher", { description: errorMessage(error) }),
    });
}

export function useRunWatcher() {
    const invalidate = useInvalidateWatchers();

    return useMutation({
        mutationFn: (id: number) => apiClient.runWatcher(id),
        onSuccess: (response) => {
            invalidate(response.watcher.id);
            const { check, watcher } = response;
            const label = `${watcher.name}: ${check.detail}`;

            if (check.status === "up") {
                toast.success(label);
            } else if (check.status === "degraded") {
                toast.warning(label);
            } else if (check.status === "down") {
                toast.error(label);
            } else {
                toast.info(label);
            }
        },
        onError: (error) => toast.error("Check failed", { description: errorMessage(error) }),
    });
}

export function useTestCheck() {
    return useMutation({
        mutationFn: (input: WatcherInput) => apiClient.testCheck(input),
        onError: (error) => toast.error("Test failed", { description: errorMessage(error) }),
    });
}

export function useUpdateNotifySettings() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (patch: NotifySettingsPatch) => apiClient.updateNotifySettings(patch),
        onSuccess: (response) => {
            queryClient.setQueryData(queryKeys.notify, response);
        },
        onError: (error) => toast.error("Could not save notification settings", { description: errorMessage(error) }),
    });
}

export function useTestNotification() {
    return useMutation({
        mutationFn: (channel?: NotifyChannel) => apiClient.testNotification(channel),
        onSuccess: (result) => {
            toast.success(
                result.channels.length > 0
                    ? `Demo sent via ${result.channels.join(", ")}`
                    : "Demo sent, but no channel is enabled"
            );
        },
        onError: (error) => toast.error("Demo notification failed", { description: errorMessage(error) }),
    });
}

export function useTargets() {
    return useQuery({
        queryKey: queryKeys.targets,
        queryFn: () => apiClient.listTargets(),
        select: (response) => response.targets,
    });
}

function useInvalidateTargets() {
    const queryClient = useQueryClient();

    return () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.targets });
        void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    };
}

export function useCreateTarget() {
    const invalidate = useInvalidateTargets();

    return useMutation({
        mutationFn: (input: NotifyTargetInput) => apiClient.createTarget(input),
        onSuccess: (response) => {
            invalidate();
            toast.success(`Target "${response.target.name}" added to the library`);
        },
        onError: (error) => toast.error("Could not add target", { description: errorMessage(error) }),
    });
}

export function useUpdateTarget() {
    const invalidate = useInvalidateTargets();

    return useMutation({
        mutationFn: (args: { id: number; patch: NotifyTargetPatch }) => apiClient.updateTarget(args.id, args.patch),
        onSuccess: () => invalidate(),
        onError: (error) => toast.error("Could not update target", { description: errorMessage(error) }),
    });
}

export function useDeleteTarget() {
    const invalidate = useInvalidateTargets();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteTarget(id),
        onSuccess: () => {
            invalidate();
            toast.success("Target deleted");
        },
        onError: (error) => toast.error("Could not delete target", { description: errorMessage(error) }),
    });
}

export function useTestTarget() {
    return useMutation({
        mutationFn: (id: number) => apiClient.testTarget(id),
        onSuccess: (response) => toast.success(`Demo sent through "${response.target.name}"`),
        onError: (error) => toast.error("Demo failed", { description: errorMessage(error) }),
    });
}

export function useFeedItems(id: number, enabled: boolean) {
    return useQuery({
        queryKey: queryKeys.feedItems(id),
        queryFn: () => apiClient.listFeedItems(id, 50),
        select: (response) => response.items,
        enabled,
    });
}

export function useStatuspageComponents() {
    return useMutation({
        mutationFn: (target: string) => apiClient.statuspageComponents(target),
        onError: (error) => toast.error("Could not read the status page", { description: errorMessage(error) }),
    });
}

let liveConnected = false;
const liveListeners = new Set<() => void>();

function setLiveConnected(value: boolean): void {
    if (liveConnected === value) {
        return;
    }

    liveConnected = value;

    for (const listener of liveListeners) {
        listener();
    }
}

/** Connection state of the one WebSocket the root layout owns; pages read it without opening their own. */
export function useLiveStatus(): boolean {
    return useSyncExternalStore(
        (listener) => {
            liveListeners.add(listener);

            return () => {
                liveListeners.delete(listener);
            };
        },
        () => liveConnected
    );
}

/** Live updates: every server event refreshes the queries it touches. Mount once, in the root layout. */
export function useLiveUpdates(enabled = true) {
    const invalidate = useInvalidateWatchers();
    const stream = useEventStream({
        enabled,
        onEvent: (event: MonitorEvent) => {
            switch (event.type) {
                case "watcher:checked":
                case "watcher:state":
                case "watcher:created":
                case "watcher:updated":
                    invalidate(event.watcher.id);
                    break;
                case "watcher:deleted":
                    invalidate(event.watcherId);
                    break;
                case "feed:items":
                    invalidate(event.watcher.id);
                    toast.info(
                        `${event.watcher.name}: ${event.items.length} new item${event.items.length === 1 ? "" : "s"}`,
                        {
                            description: event.items[0]?.title,
                        }
                    );
                    break;
                default:
                    break;
            }

            if (event.type === "watcher:state" && event.to !== "unknown") {
                const label = `${event.watcher.name}: ${event.from} → ${event.to}`;

                if (event.to === "up") {
                    toast.success(label, { description: event.watcher.lastDetail ?? undefined });
                } else if (event.to === "degraded") {
                    toast.warning(label, { description: event.watcher.lastDetail ?? undefined });
                } else {
                    toast.error(label, { description: event.watcher.lastDetail ?? undefined });
                }
            }
        },
    });

    useEffect(() => {
        setLiveConnected(stream.connected);
    }, [stream.connected]);

    return stream;
}
