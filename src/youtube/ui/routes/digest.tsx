import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { useDigest, useDigestSync } from "@app/yt/api.hooks";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/digest")({
    component: DigestPage,
});

const SINCE_OPTIONS = [7, 30, 90];

function DigestPage() {
    const [sinceDays, setSinceDays] = useState(7);
    const digest = useDigest(sinceDays);
    const sync = useDigestSync();
    const navigate = useNavigate();
    const channels = digest.data?.channels ?? [];
    const totalVideos = channels.reduce((sum, channel) => sum + channel.videos.length, 0);

    return (
        <div className="mx-auto max-w-4xl space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-xl font-semibold">Digest</h1>
                <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
                    <RefreshCw className="mr-2 size-4" /> Check for new videos
                </Button>
            </div>

            <div className="flex items-center gap-2">
                {SINCE_OPTIONS.map((days) => (
                    <Button
                        key={days}
                        size="sm"
                        variant={sinceDays === days ? "default" : "outline"}
                        onClick={() => setSinceDays(days)}
                    >
                        Last {days} days
                    </Button>
                ))}
            </div>

            {digest.isPending ? <p className="text-sm text-muted-foreground">Loading digest…</p> : null}

            {!digest.isPending && channels.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    Follow channels to build your digest.{" "}
                    <Link to="/" className="underline">
                        Browse channels
                    </Link>
                </p>
            ) : null}

            {!digest.isPending && channels.length > 0 && totalVideos === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing new since {digest.data?.since}.</p>
            ) : null}

            <div className="space-y-4">
                {channels
                    .filter((channel) => channel.videos.length > 0)
                    .map((channel) => (
                        <Card key={channel.handle}>
                            <CardHeader>
                                <CardTitle className="text-base">{channel.handle}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2">
                                {channel.videos.map((video) => (
                                    <div key={video.id} className="flex items-center gap-3">
                                        {video.thumbUrl ? (
                                            <button
                                                type="button"
                                                className="shrink-0"
                                                onClick={() =>
                                                    void navigate({ to: "/videos/$id", params: { id: video.id } })
                                                }
                                            >
                                                <img
                                                    src={video.thumbUrl}
                                                    alt=""
                                                    className="h-14 w-24 rounded object-cover"
                                                />
                                            </button>
                                        ) : null}
                                        <div className="min-w-0 flex-1">
                                            <button
                                                type="button"
                                                className="block truncate text-left text-sm font-medium hover:underline"
                                                onClick={() =>
                                                    void navigate({ to: "/videos/$id", params: { id: video.id } })
                                                }
                                            >
                                                {video.title}
                                            </button>
                                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                                {video.uploadDate ? (
                                                    <span className="text-xs text-muted-foreground">
                                                        {video.uploadDate}
                                                    </span>
                                                ) : null}
                                                {video.hasSummary ? <Badge variant="secondary">Summary</Badge> : null}
                                                {video.hasTranscript ? (
                                                    <Badge variant="secondary">Transcript</Badge>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    ))}
            </div>
        </div>
    );
}
