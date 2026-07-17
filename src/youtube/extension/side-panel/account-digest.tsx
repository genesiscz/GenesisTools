import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { useDigest, useDigestSync } from "@ext/api.hooks";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

const SINCE_OPTIONS = [7, 30, 90];

export function DigestSection({ onOpenWatch }: { onOpenWatch: (videoId: string, t: number) => void }) {
    const [sinceDays, setSinceDays] = useState(7);
    const digest = useDigest(sinceDays);
    const sync = useDigestSync();
    const channels = digest.data?.channels ?? [];
    const totalVideos = channels.reduce((sum, channel) => sum + channel.videos.length, 0);

    return (
        <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
                <div className="flex gap-1 rounded-lg border border-white/8 bg-black/20 p-1">
                    {SINCE_OPTIONS.map((days) => (
                        <button
                            key={days}
                            type="button"
                            onClick={() => setSinceDays(days)}
                            className={`h-7 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors ${
                                sinceDays === days
                                    ? "bg-white/10 text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            {days}d
                        </button>
                    ))}
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={sync.isPending}
                    onClick={() => sync.mutate()}
                >
                    {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    Check
                </Button>
            </div>

            {digest.isError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">
                        {digest.error instanceof Error ? digest.error.message : "Failed to load digest."}
                    </p>
                </div>
            ) : digest.isPending ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                </div>
            ) : channels.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                    Follow channels (from a channel's panel) to build your digest.
                </p>
            ) : totalVideos === 0 ? (
                <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                    Nothing new since {digest.data?.since}.
                </p>
            ) : (
                <div className="space-y-4">
                    {channels
                        .filter((channel) => channel.videos.length > 0)
                        .map((channel) => (
                            <section key={channel.handle} className="space-y-2">
                                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">
                                    {channel.handle}
                                </p>
                                <ul className="space-y-2">
                                    {channel.videos.map((video) => (
                                        <li key={video.id}>
                                            <button
                                                type="button"
                                                onClick={() => onOpenWatch(video.id, 0)}
                                                className="flex w-full gap-3 rounded-2xl border border-primary/15 bg-black/20 p-2 text-left transition-colors hover:border-primary/40"
                                            >
                                                {video.thumbUrl ? (
                                                    <img
                                                        src={video.thumbUrl}
                                                        alt=""
                                                        className="h-14 w-24 shrink-0 rounded-lg object-cover"
                                                    />
                                                ) : null}
                                                <span className="min-w-0 flex-1">
                                                    <span className="block break-words text-sm leading-snug text-foreground/90">
                                                        {video.title}
                                                    </span>
                                                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                                        {video.uploadDate ? (
                                                            <span className="text-xs text-muted-foreground">
                                                                {video.uploadDate}
                                                            </span>
                                                        ) : null}
                                                        {video.hasSummary ? (
                                                            <Badge variant="secondary">Summary</Badge>
                                                        ) : null}
                                                        {video.hasTranscript ? (
                                                            <Badge variant="secondary">Transcript</Badge>
                                                        ) : null}
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                </div>
            )}
        </div>
    );
}
