import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent } from "@app/utils/ui/components/card";
import { CollectionAskPanel } from "@app/utils/ui/components/youtube/collection-ask-panel";
import { optimisticUserMessage, ruleSummary } from "@app/utils/ui/components/youtube/collection-ui";
import { useAskCollection, useCollection, useRemoveCollectionVideo, useThread, useThreads } from "@app/yt/api.hooks";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/collections_/$id")({
    component: CollectionDetailPage,
});

function CollectionDetailPage() {
    const params = Route.useParams();
    const id = Number.parseInt(params.id, 10);
    const validId = Number.isNaN(id) ? null : id;
    const collection = useCollection(validId);
    const threads = useThreads(validId);
    const [threadId, setThreadId] = useState<number | null>(null);
    const thread = useThread(threadId);
    const ask = useAskCollection(validId ?? 0);
    const removeVideo = useRemoveCollectionVideo(validId ?? 0);
    const navigate = useNavigate();
    const [pending, setPending] = useState<string | null>(null);

    if (collection.isPending) {
        return <p className="mx-auto max-w-4xl p-4 text-sm text-muted-foreground">Loading collection…</p>;
    }

    if (!collection.data) {
        return <p className="mx-auto max-w-4xl p-4 text-sm text-muted-foreground">Collection not found.</p>;
    }

    const record = collection.data.collection;
    const videos = collection.data.videos;
    const baseMessages = thread.data?.messages ?? [];
    const messages =
        ask.isPending && pending ? [...baseMessages, optimisticUserMessage(threadId, pending)] : baseMessages;

    const onSend = (question: string) => {
        setPending(question);
        ask.mutate(
            { question, threadId: threadId ?? undefined },
            {
                onSuccess: (result) => setThreadId(result.threadId),
                onSettled: () => setPending(null),
            }
        );
    };

    return (
        <div className="mx-auto max-w-4xl space-y-4 p-4">
            <header className="space-y-1">
                <h1 className="text-xl font-semibold">{record.name}</h1>
                <div className="flex items-center gap-2">
                    <Badge variant="secondary">{record.kind}</Badge>
                    {record.kind === "dynamic" ? (
                        <span className="text-xs text-muted-foreground">{ruleSummary(record.ruleJson)}</span>
                    ) : null}
                </div>
            </header>

            <div className="grid gap-3 sm:grid-cols-2">
                {videos.map((video) => (
                    <Card key={video.id}>
                        <CardContent className="flex gap-3 pt-6">
                            {video.thumbUrl ? (
                                <button
                                    type="button"
                                    className="shrink-0"
                                    onClick={() => void navigate({ to: "/videos/$id", params: { id: video.id } })}
                                >
                                    <img src={video.thumbUrl} alt="" className="h-16 w-28 rounded object-cover" />
                                </button>
                            ) : null}
                            <div className="min-w-0 flex-1">
                                <button
                                    type="button"
                                    className="block truncate text-left text-sm font-medium hover:underline"
                                    onClick={() => void navigate({ to: "/videos/$id", params: { id: video.id } })}
                                >
                                    {video.title}
                                </button>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                    {video.hasSummary ? <Badge variant="secondary">Summary</Badge> : null}
                                    {video.hasTranscript ? <Badge variant="secondary">Transcript</Badge> : null}
                                    {record.kind === "manual" ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={removeVideo.isPending}
                                            onClick={() => removeVideo.mutate(video.id)}
                                        >
                                            Remove
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                ))}
                {videos.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {record.kind === "manual"
                            ? "No videos yet. Add some from a video page."
                            : "No videos match this rule yet."}
                    </p>
                ) : null}
            </div>

            <section className="space-y-2">
                <h2 className="text-base font-semibold">Ask this collection</h2>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        variant={threadId === null ? "default" : "outline"}
                        onClick={() => setThreadId(null)}
                    >
                        New conversation
                    </Button>
                    {(threads.data ?? []).map((item) => (
                        <Button
                            key={item.id}
                            size="sm"
                            variant={threadId === item.id ? "default" : "outline"}
                            onClick={() => setThreadId(item.id)}
                        >
                            {item.title}
                        </Button>
                    ))}
                </div>
                <CollectionAskPanel
                    messages={messages}
                    busy={ask.isPending}
                    error={ask.error ? (ask.error as Error).message : null}
                    onSend={onSend}
                />
            </section>
        </div>
    );
}
