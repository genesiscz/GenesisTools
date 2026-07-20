import type { ChannelHandle } from "@app/youtube/lib/types";
import { useChannelVideos, useConfig, useEnsureChannel, useMe, useToggleWatchlist, useWatchlist } from "@ext/api.hooks";
import { youtubeChannelWebUrl } from "@ext/shared/web-ui-url";
import { Header } from "@ext/side-panel/header";
import { Button } from "@genesiscz/utils/ui/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/** How long to poll for discover results while ensure is syncing. */
const POST_ENSURE_POLL_MS = 90_000;

export function ChannelPanel({ handle }: { handle: string | null }) {
    const channelHandle = handle as ChannelHandle | null;
    const queryClient = useQueryClient();
    const config = useConfig();
    const ensure = useEnsureChannel(channelHandle);
    const [pollVideosUntil, setPollVideosUntil] = useState<number | null>(null);
    const videos = useChannelVideos(channelHandle, {
        limit: 20,
        includeShorts: true,
        pollWhileEmptyUntil: pollVideosUntil,
    });
    const [collapsed, setCollapsed] = useState(false);
    const me = useMe();
    const watchlist = useWatchlist(Boolean(me.data?.user));
    const toggleWatchlist = useToggleWatchlist();

    const syncStatus = ensure.data?.syncStatus;
    const tracked = ensure.data?.tracked === true;
    const syncing = syncStatus === "queued" || syncStatus === "running";
    const queuePosition = ensure.data?.queuePosition ?? null;
    const followed =
        channelHandle !== null && (watchlist.data ?? []).some((entry) => entry.channelHandle === channelHandle);
    const rows = videos.data ?? [];
    const awaitingVideos =
        tracked && rows.length === 0 && pollVideosUntil !== null && Date.now() < pollVideosUntil && !videos.isError;
    const base = config.data?.apiBaseUrl.replace(/\/$/, "") ?? "";
    const webUrl = channelHandle && base ? youtubeChannelWebUrl(base, channelHandle) : "";

    useEffect(() => {
        if (syncing) {
            setPollVideosUntil(Date.now() + POST_ENSURE_POLL_MS);
        }
    }, [syncing]);

    useEffect(() => {
        if (!channelHandle || syncStatus !== "synced") {
            return;
        }

        void queryClient.invalidateQueries({ queryKey: ["channels"] });
        void queryClient.invalidateQueries({ queryKey: ["videos", channelHandle] });
    }, [channelHandle, syncStatus, queryClient]);

    return (
        <div className="flex h-auto min-h-0 flex-col overflow-hidden rounded-xl border border-white/8 bg-card">
            <Header collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />
            <div
                className="yt-body-collapsible min-h-0 flex-1"
                data-collapsed={collapsed}
                inert={collapsed}
                aria-hidden={collapsed}
            >
                <div className="yt-scroll min-h-0 flex-1 space-y-4 overflow-auto p-4">
                    <div>
                        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">Channel</p>
                        <h2 className="mt-1 text-lg font-semibold text-foreground">
                            {channelHandle ?? "This channel"}
                        </h2>
                    </div>

                    {channelHandle === null ? (
                        <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                            Couldn't resolve this channel's @handle from the page. Open one of its videos or its main
                            tab and try again.
                        </p>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            {ensure.isPending || syncing ? (
                                <div className="flex items-center gap-2 rounded-2xl border border-primary/20 bg-black/20 px-3 py-2 text-sm text-muted-foreground">
                                    <Loader2 className="size-4 animate-spin text-secondary" />
                                    <span>
                                        {syncStatus === "running"
                                            ? "Discovering channel…"
                                            : queuePosition != null
                                              ? `Not tracked yet — queued (#${queuePosition})`
                                              : "Not tracked yet — queuing discover…"}
                                    </span>
                                </div>
                            ) : syncStatus === "synced" ? (
                                <div className="rounded-2xl border border-primary/15 bg-black/20 px-3 py-2 text-sm text-foreground/80">
                                    Tracked in GenesisTools
                                </div>
                            ) : ensure.isError ? (
                                <p className="text-xs text-destructive">
                                    {ensure.error instanceof Error
                                        ? ensure.error.message
                                        : "Failed to ensure channel tracking."}
                                </p>
                            ) : null}
                            {me.data?.user ? (
                                <Button
                                    variant={followed ? "cyber-secondary" : "default"}
                                    title={
                                        followed
                                            ? "Remove from your personal digest watchlist"
                                            : "Follow for your personal digest (new uploads from this channel)"
                                    }
                                    disabled={toggleWatchlist.isPending}
                                    onClick={() => toggleWatchlist.mutate({ handle: channelHandle, follow: !followed })}
                                >
                                    {followed ? "Following" : "Follow for digest"}
                                </Button>
                            ) : null}
                            {webUrl ? (
                                <Button asChild variant="cyber-secondary">
                                    <a href={webUrl} target="_blank" rel="noopener noreferrer">
                                        <ExternalLink className="size-4" />
                                        Open in GenesisTools
                                    </a>
                                </Button>
                            ) : null}
                        </div>
                    )}

                    {me.data?.user && channelHandle !== null ? (
                        <p className="text-[11px] leading-snug text-muted-foreground">
                            Opening a channel auto-queues discover. <span className="text-secondary">Follow</span> adds
                            it to your personal digest.
                        </p>
                    ) : null}

                    {toggleWatchlist.isError ? (
                        <p className="text-xs text-destructive">
                            {toggleWatchlist.error instanceof Error
                                ? toggleWatchlist.error.message
                                : "Failed to update digest follow."}
                        </p>
                    ) : null}

                    <section className="space-y-2">
                        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">
                            Recent tracked videos
                        </p>
                        {channelHandle !== null && videos.isPending ? (
                            <p className="text-sm text-muted-foreground">Loading…</p>
                        ) : videos.isError ? (
                            <p className="rounded-2xl border border-dashed border-destructive/40 p-4 text-sm text-destructive/90">
                                {videos.error instanceof Error
                                    ? videos.error.message
                                    : "Couldn't load this channel's videos."}
                            </p>
                        ) : rows.length === 0 ? (
                            <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                                {awaitingVideos || syncing
                                    ? "Fetching videos… they'll show up here as the discover job finishes."
                                    : tracked
                                      ? "No videos for this channel yet. They'll appear here once discover finishes."
                                      : "No videos for this channel yet."}
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {rows.map((video) => (
                                    <li key={video.id}>
                                        <a
                                            href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`}
                                            className="flex gap-3 rounded-2xl border border-primary/15 bg-black/20 p-2 transition-colors hover:border-primary/40"
                                        >
                                            {video.thumbUrl ? (
                                                <img
                                                    src={video.thumbUrl}
                                                    alt=""
                                                    className="h-14 w-24 shrink-0 rounded-lg object-cover"
                                                />
                                            ) : null}
                                            <span className="min-w-0 flex-1 break-words text-sm leading-snug text-foreground/90">
                                                {video.title}
                                            </span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
