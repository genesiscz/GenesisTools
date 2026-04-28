import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { useChannels } from "@app/yt/api.hooks";
import { AddChannelDialog } from "@app/yt/components/channels/add-channel-dialog";
import { ChannelCard } from "@app/yt/components/channels/channel-card";
import { EmptyState } from "@app/yt/components/shared/empty-state";
import { Loading } from "@app/yt/components/shared/loading";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

export function ChannelsGrid() {
    const channels = useChannels();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const filtered = useMemo(() => {
        const query = search.toLowerCase();
        return (channels.data ?? []).filter((channel) =>
            `${channel.handle} ${channel.title ?? ""}`.toLowerCase().includes(query)
        );
    }, [channels.data, search]);

    if (channels.isPending) {
        return <Loading label="Loading channels" />;
    }

    return (
        <div className="space-y-6">
            <header className="flex flex-col gap-4 rounded-3xl border border-primary/20 bg-black/25 p-5 md:flex-row md:items-center md:justify-between">
                <div>
                    <p className="font-mono text-xs uppercase tracking-[0.3em] text-secondary">Library</p>
                    <h1 className="gradient-text text-3xl font-bold">Channels</h1>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search channels"
                            className="pl-9 sm:w-72"
                        />
                    </div>
                    <Button onClick={() => setOpen(true)} className="btn-glow">
                        <Plus className="mr-2 size-4" /> Add channel
                    </Button>
                </div>
            </header>
            {channels.data?.length === 0 ? (
                <EmptyState
                    title="No channels yet"
                    body="Track a channel to start indexing its videos, transcripts, summaries, and jobs."
                    cta={<Button onClick={() => setOpen(true)}>Add your first channel</Button>}
                />
            ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {filtered.map((channel) => (
                        <ChannelCard key={channel.handle} channel={channel} />
                    ))}
                </div>
            )}
            <AddChannelDialog open={open} onOpenChange={setOpen} />
        </div>
    );
}
