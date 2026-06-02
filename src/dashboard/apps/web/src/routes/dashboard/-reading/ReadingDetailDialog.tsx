import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { IconButton } from "@ui/components/icon-button";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import { EmptyState, IconContainer } from "@ui/custom";
import { Highlighter, Loader2, Plus, Quote, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { ReadingItemRow } from "@/lib/reading/reading.server";
import {
    useCreateReadingHighlightMutation,
    useDeleteReadingHighlightMutation,
    useReadingHighlightsQuery,
} from "@/lib/reading/hooks/useReadingQueries";

interface ReadingDetailDialogProps {
    item: ReadingItemRow | null;
    onOpenChange: (open: boolean) => void;
}

export function ReadingDetailDialog({ item, onOpenChange }: ReadingDetailDialogProps) {
    const itemId = item?.id ?? null;
    const highlightsQuery = useReadingHighlightsQuery(itemId);
    const createMut = useCreateReadingHighlightMutation();
    const deleteMut = useDeleteReadingHighlightMutation();

    const [text, setText] = useState("");
    const [note, setNote] = useState("");
    const [location, setLocation] = useState("");

    const highlights = highlightsQuery.data ?? [];

    async function handleAdd(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!item || !text.trim()) {
            return;
        }

        await createMut.mutateAsync({
            id: crypto.randomUUID(),
            userId: item.userId,
            itemId: item.id,
            text: text.trim(),
            note: note.trim(),
            location: location.trim(),
            createdAt: new Date().toISOString(),
            metadataJson: "{}",
        });
        setText("");
        setNote("");
        setLocation("");
    }

    async function handleDelete(highlightId: string) {
        if (!item) {
            return;
        }

        await deleteMut.mutateAsync({ id: highlightId, itemId: item.id });
    }

    return (
        <Dialog open={!!item} onOpenChange={onOpenChange}>
            <DialogContent
                className="max-w-lg border-purple-500/30 bg-black/95 backdrop-blur-xl"
                data-testid="reading-detail-dialog"
            >
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <IconContainer variant="purple" icon={<Highlighter className="h-4 w-4" />} />
                        <div className="min-w-0">
                            <DialogTitle className="truncate">{item?.title}</DialogTitle>
                            <DialogDescription>
                                {item?.author ? `${item.author} · ` : ""}
                                {highlights.length} highlight{highlights.length === 1 ? "" : "s"}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                {/* Add highlight form */}
                <form onSubmit={handleAdd} className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                    <Textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Paste a passage worth keeping…"
                        rows={2}
                        data-testid="highlight-text-input"
                    />
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                        <Input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Note (optional)"
                            data-testid="highlight-note-input"
                        />
                        <Input
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                            placeholder="p. 42"
                            className="w-24"
                            data-testid="highlight-location-input"
                        />
                    </div>
                    <Button
                        type="submit"
                        variant="brand"
                        size="sm"
                        disabled={!text.trim() || createMut.isPending}
                        className="w-full gap-2"
                        data-testid="add-highlight-button"
                    >
                        {createMut.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Plus className="h-4 w-4" />
                        )}
                        Add highlight
                    </Button>
                </form>

                {/* Highlights list */}
                <div className="max-h-[40vh] space-y-2 overflow-y-auto pr-1" data-testid="highlights-list">
                    {highlightsQuery.isLoading ? (
                        <div className="flex justify-center py-6 text-muted-foreground">
                            <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                    ) : highlights.length === 0 ? (
                        <EmptyState
                            icon={Quote}
                            title="No highlights yet"
                            description="Capture passages and notes as you read."
                            iconSize="md"
                            rings={false}
                        />
                    ) : (
                        highlights.map((h) => (
                            <div
                                key={h.id}
                                className="group relative rounded-lg border border-border bg-card/60 p-3"
                                data-testid="highlight-item"
                            >
                                <div className="flex gap-2">
                                    <Quote className="mt-0.5 h-4 w-4 shrink-0 text-primary/60" />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm leading-relaxed text-foreground/90">{h.text}</p>
                                        {h.note && (
                                            <p className="mt-1.5 text-xs italic text-muted-foreground">{h.note}</p>
                                        )}
                                        {h.location && (
                                            <span className="mt-1.5 inline-block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
                                                {h.location}
                                            </span>
                                        )}
                                    </div>
                                    <IconButton
                                        variant="ghost"
                                        size="icon"
                                        tooltip="Delete highlight"
                                        onClick={() => handleDelete(h.id)}
                                        className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </IconButton>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
