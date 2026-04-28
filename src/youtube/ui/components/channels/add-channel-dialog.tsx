import { Button } from "@app/utils/ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@app/utils/ui/components/dialog";
import { Textarea } from "@app/utils/ui/components/textarea";
import type { ChannelHandle } from "@app/youtube/lib/types";
import { useAddChannels, useSyncChannel } from "@app/yt/api.hooks";
import { FileUp, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

export function AddChannelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const [rawHandles, setRawHandles] = useState("");
    const fileRef = useRef<HTMLInputElement | null>(null);
    const addChannels = useAddChannels();
    const syncChannel = useSyncChannel();
    const handles = parseHandles(rawHandles);

    async function onSubmit() {
        if (handles.length === 0) {
            toast.error("Add at least one channel handle");
            return;
        }

        const result = await addChannels.mutateAsync(handles);
        await Promise.all(result.added.map((handle) => syncChannel.mutateAsync({ handle })));
        toast.success(`${result.added.length} channel${result.added.length === 1 ? "" : "s"} added and queued`);
        setRawHandles("");
        onOpenChange(false);
    }

    async function onFile(file: File | undefined) {
        if (!file) {
            return;
        }

        const text = await file.text();
        setRawHandles((current) => [current, text].filter(Boolean).join("\n"));
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="yt-panel border-primary/30 sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="gradient-text text-2xl">Track channels</DialogTitle>
                    <DialogDescription>
                        Paste handles, channel URLs, or one handle per line. Imports normalize to @handles before
                        sending.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <Textarea
                        value={rawHandles}
                        onChange={(event) => setRawHandles(event.target.value)}
                        placeholder="@mkbhd\nhttps://youtube.com/@veritasium"
                        className="min-h-44 font-mono"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span>
                            {handles.length} valid handle{handles.length === 1 ? "" : "s"} detected
                        </span>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".txt,.csv"
                            className="hidden"
                            onChange={(event) => onFile(event.target.files?.[0])}
                        />
                        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                            <FileUp className="mr-2 size-4" /> Bulk import from file
                        </Button>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={onSubmit}
                        disabled={addChannels.isPending || syncChannel.isPending}
                        className="btn-glow"
                    >
                        <Plus className="mr-2 size-4" /> Add and sync
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function parseHandles(value: string): ChannelHandle[] {
    const handles = value
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const match = part.match(/(?:youtube\.com\/)?(@[A-Za-z0-9._-]+)/);
            return match?.[1] ?? (part.startsWith("@") ? part : `@${part}`);
        })
        .filter((part): part is ChannelHandle => /^@[A-Za-z0-9._-]+$/.test(part));

    return Array.from(new Set(handles));
}
