import { Badge } from "@app/utils/ui/components/badge";
import { Card, CardContent } from "@app/utils/ui/components/card";
import type { Video } from "@app/youtube/lib/types";
import { formatDate, formatDuration, formatNumber } from "@app/yt/lib/format";
import { useNavigate } from "@tanstack/react-router";
import { Captions, Eye, Radio } from "lucide-react";

export function VideoCard({ video }: { video: Video }) {
    const navigate = useNavigate();

    return (
        <Card
            className="yt-panel yt-card-hover group cursor-pointer overflow-hidden"
            onClick={() => navigate({ to: "/videos/$id", params: { id: video.id } })}
        >
            <div className="relative aspect-video overflow-hidden bg-black/40">
                {video.thumbUrl ? (
                    <img
                        src={video.thumbUrl}
                        alt=""
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105 group-hover:brightness-110"
                    />
                ) : (
                    <div className="grid h-full place-items-center text-primary">
                        <Radio className="size-10" />
                    </div>
                )}
                <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-2 py-1 font-mono text-xs text-white">
                    {formatDuration(video.durationSec)}
                </span>
                {video.isShort ? <Badge className="absolute left-2 top-2">Short</Badge> : null}
            </div>
            <CardContent className="space-y-3 p-4">
                <h3 className="line-clamp-2 min-h-12 font-semibold leading-6">{video.title}</h3>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant={video.availableCaptionLangs.length > 0 ? "cyber-secondary" : "outline"}>
                        <Captions className="size-3" />{" "}
                        {video.availableCaptionLangs.length > 0 ? "captions" : "no captions"}
                    </Badge>
                    <Badge variant="outline">
                        <Eye className="size-3" /> {formatNumber(video.viewCount)}
                    </Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                    {formatDate(video.uploadDate)} · {video.channelHandle}
                </p>
            </CardContent>
        </Card>
    );
}
