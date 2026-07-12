import { Button } from "@app/utils/ui/components/button";
import type { ChannelHandle } from "@app/youtube/lib/types";
import { useAddChannel, useChannels, useChannelVideos, useConfig } from "@ext/api.hooks";
import { Header } from "@ext/side-panel/header";
import { ExternalLink, Plus } from "lucide-react";

export function ChannelPanel({ handle, onClose }: { handle: string | null; onClose: () => void }) {
    const channelHandle = handle as ChannelHandle | null;
    const config = useConfig();
    const channels = useChannels();
    const addChannel = useAddChannel();
    const videos = useChannelVideos(channelHandle, { limit: 20, includeShorts: true });

    const tracked = channelHandle !== null && (channels.data ?? []).some((item) => item.handle === channelHandle);
    const rows = videos.data ?? [];
    const base = config.data?.apiBaseUrl.replace(/\/$/, "") ?? "";
    const webUrl = channelHandle ? `${base}/channels/${encodeURIComponent(channelHandle)}` : base;

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground shadow-[-24px_0_70px_rgba(0,0,0,0.55)]">
            <Header onClose={onClose} />
            <div className="yt-scroll min-h-0 flex-1 space-y-4 overflow-auto p-4">
                <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-secondary">Channel</p>
                    <h2 className="mt-1 text-lg font-semibold text-foreground">{channelHandle ?? "This channel"}</h2>
                </div>

                {channelHandle === null ? (
                    <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                        Couldn't resolve this channel's @handle from the page. Open one of its videos or its main tab
                        and try again.
                    </p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        <Button
                            onClick={() => addChannel.mutate(channelHandle)}
                            disabled={addChannel.isPending || tracked}
                        >
                            <Plus className="size-4" />
                            {tracked ? "Tracked" : addChannel.isPending ? "Tracking…" : "Track this channel"}
                        </Button>
                        {base ? (
                            <Button asChild variant="cyber-secondary">
                                <a href={webUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="size-4" />
                                    Open in GenesisTools
                                </a>
                            </Button>
                        ) : null}
                    </div>
                )}

                {addChannel.isError ? (
                    <p className="text-xs text-destructive">
                        {addChannel.error instanceof Error ? addChannel.error.message : "Failed to track channel."}
                    </p>
                ) : null}

                <section className="space-y-2">
                    <p className="font-mono text-xs uppercase tracking-[0.28em] text-secondary">
                        Recent tracked videos
                    </p>
                    {channelHandle !== null && videos.isPending ? (
                        <p className="text-sm text-muted-foreground">Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                            No ingested videos for this channel yet.
                            {tracked
                                ? " Run a sync from the web UI to fetch its videos."
                                : " Track it, then sync from the web UI."}
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
    );
}
