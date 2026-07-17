import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { CollectionAskPanel } from "@app/utils/ui/components/youtube/collection-ask-panel";
import { optimisticUserMessage, ruleSummary } from "@app/utils/ui/components/youtube/collection-ui";
import {
    useAskCollection,
    useCollection,
    useCollections,
    useCollectionThread,
    useCollectionThreads,
    useCreateCollection,
    useDeleteCollection,
    useRemoveCollectionVideo,
} from "@ext/api.hooks";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

const KIND_PRESETS: Array<{ value: string; label: string }> = [
    { value: "manual", label: "Manual — add videos yourself" },
    { value: "watched:7", label: "Dynamic — watched last 7 days" },
    { value: "watched:30", label: "Dynamic — watched last 30 days" },
    { value: "watched:90", label: "Dynamic — watched last 90 days" },
];

function buildCreateBody(name: string, preset: string) {
    if (preset === "manual") {
        return { name, kind: "manual" as const };
    }

    const sinceDays = Number.parseInt(preset.split(":")[1] ?? "30", 10);

    return { name, kind: "dynamic" as const, rule: { type: "watched", sinceDays } };
}

export function CollectionsSection({ onOpenWatch }: { onOpenWatch: (videoId: string, t: number) => void }) {
    const [selectedId, setSelectedId] = useState<number | null>(null);

    if (selectedId !== null) {
        return <CollectionDetail id={selectedId} onBack={() => setSelectedId(null)} onOpenWatch={onOpenWatch} />;
    }

    return <CollectionsList onOpen={setSelectedId} />;
}

function CollectionsList({ onOpen }: { onOpen: (id: number) => void }) {
    const collections = useCollections();
    const create = useCreateCollection();
    const remove = useDeleteCollection();
    const [name, setName] = useState("");
    const [preset, setPreset] = useState("manual");

    const onCreate = () => {
        const trimmed = name.trim();

        if (!trimmed || create.isPending) {
            return;
        }

        create.mutate(buildCreateBody(trimmed, preset), { onSuccess: () => setName("") });
    };

    return (
        <div className="space-y-3 p-4">
            <div className="space-y-2 rounded-2xl border border-white/8 bg-black/20 p-3">
                <Input
                    placeholder="New collection name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="h-9 text-sm"
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            onCreate();
                        }
                    }}
                />
                <Select value={preset} onValueChange={setPreset}>
                    <SelectTrigger className="h-8 w-full text-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {KIND_PRESETS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button size="sm" className="w-full" disabled={create.isPending || !name.trim()} onClick={onCreate}>
                    Create collection
                </Button>
            </div>

            {create.isError ? (
                <p className="text-xs text-destructive/90">
                    {create.error instanceof Error ? create.error.message : "Failed to create collection."}
                </p>
            ) : null}

            {collections.isError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm">
                    <p className="break-words text-destructive/90">
                        {collections.error instanceof Error ? collections.error.message : "Failed to load collections."}
                    </p>
                </div>
            ) : collections.isPending ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                </div>
            ) : (collections.data ?? []).length === 0 ? (
                <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                    No collections yet. Create one above.
                </p>
            ) : (
                <div className="space-y-2">
                    {(collections.data ?? []).map((collection) => (
                        <div
                            key={collection.id}
                            className="flex items-center gap-2 rounded-2xl border border-white/8 bg-black/20 p-3"
                        >
                            <button
                                type="button"
                                className="min-w-0 flex-1 text-left"
                                onClick={() => onOpen(collection.id)}
                            >
                                <p className="truncate text-sm font-semibold text-foreground/95 hover:underline">
                                    {collection.name}
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    {collection.kind} · {collection.videoCount} video
                                    {collection.videoCount === 1 ? "" : "s"}
                                </p>
                            </button>
                            <button
                                type="button"
                                aria-label={`Delete ${collection.name}`}
                                disabled={remove.isPending}
                                onClick={() => remove.mutate(collection.id)}
                                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                            >
                                <Trash2 className="size-4" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function CollectionDetail({
    id,
    onBack,
    onOpenWatch,
}: {
    id: number;
    onBack: () => void;
    onOpenWatch: (videoId: string, t: number) => void;
}) {
    const collection = useCollection(id);
    const threads = useCollectionThreads(id);
    const [threadId, setThreadId] = useState<number | null>(null);
    const thread = useCollectionThread(threadId);
    const ask = useAskCollection(id);
    const removeVideo = useRemoveCollectionVideo(id);
    const [pending, setPending] = useState<string | null>(null);

    const backRow = (
        <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
            <ArrowLeft className="size-4" /> Collections
        </button>
    );

    if (collection.isPending) {
        return (
            <div className="space-y-3 p-4">
                {backRow}
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                </div>
            </div>
        );
    }

    if (!collection.data) {
        return (
            <div className="space-y-3 p-4">
                {backRow}
                <p className="text-sm text-muted-foreground">Collection not found.</p>
            </div>
        );
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
        <div className="space-y-3 p-4">
            {backRow}

            <div className="space-y-1">
                <h2 className="text-lg font-semibold text-foreground">{record.name}</h2>
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{record.kind}</Badge>
                    {record.kind === "dynamic" ? (
                        <span className="text-xs text-muted-foreground">{ruleSummary(record.ruleJson)}</span>
                    ) : null}
                </div>
            </div>

            {videos.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-primary/25 p-4 text-sm text-muted-foreground">
                    {record.kind === "manual"
                        ? "No videos yet. Add some from a video's panel."
                        : "No videos match this rule yet."}
                </p>
            ) : (
                <ul className="space-y-2">
                    {videos.map((video) => (
                        <li key={video.id} className="flex gap-3 rounded-2xl border border-primary/15 bg-black/20 p-2">
                            <button
                                type="button"
                                className="flex min-w-0 flex-1 gap-3 text-left"
                                onClick={() => onOpenWatch(video.id, 0)}
                            >
                                {video.thumbUrl ? (
                                    <img
                                        src={video.thumbUrl}
                                        alt=""
                                        className="h-14 w-24 shrink-0 rounded-lg object-cover"
                                    />
                                ) : null}
                                <span className="min-w-0 flex-1">
                                    <span className="block break-words text-sm leading-snug text-foreground/90 hover:underline">
                                        {video.title}
                                    </span>
                                    <span className="mt-1 flex flex-wrap gap-1.5">
                                        {video.hasSummary ? <Badge variant="secondary">Summary</Badge> : null}
                                        {video.hasTranscript ? <Badge variant="secondary">Transcript</Badge> : null}
                                    </span>
                                </span>
                            </button>
                            {record.kind === "manual" ? (
                                <button
                                    type="button"
                                    aria-label={`Remove ${video.title}`}
                                    disabled={removeVideo.isPending}
                                    onClick={() => removeVideo.mutate(video.id)}
                                    className="grid size-7 shrink-0 place-items-center self-start rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
                                >
                                    <Trash2 className="size-4" />
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}

            <section className="space-y-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-secondary">Ask this collection</p>
                <div className="flex flex-wrap gap-1.5">
                    <ThreadPill active={threadId === null} label="New" onClick={() => setThreadId(null)} />
                    {(threads.data ?? []).map((item) => (
                        <ThreadPill
                            key={item.id}
                            active={threadId === item.id}
                            label={item.title}
                            onClick={() => setThreadId(item.id)}
                        />
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

function ThreadPill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex h-6 max-w-[12rem] items-center truncate rounded-full border px-2 text-[12px] transition-colors ${
                active
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-white/8 text-muted-foreground hover:text-foreground"
            }`}
        >
            {label}
        </button>
    );
}
