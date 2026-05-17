import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { TagChip } from "@ui/custom";
import { cn } from "@ui/lib/utils";
import { Loader2, Sparkles } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import type { BookmarkInput } from "@/lib/bookmarks/hooks/useBookmarks";
import { useFetchUrlMetadataMutation } from "@/lib/bookmarks/hooks/useBookmarksQueries";

interface BookmarkFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: BookmarkInput) => Promise<void>;
    existingTags: string[];
}

const FIELD_LABEL = "font-mono text-[10px] tracking-widest uppercase text-muted-foreground/70 mb-1 block";

export function BookmarkForm({ open, onOpenChange, onSubmit, existingTags }: BookmarkFormProps) {
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [faviconUrl, setFaviconUrl] = useState("");
    const [tagInput, setTagInput] = useState("");
    const [tags, setTags] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [urlError, setUrlError] = useState<string | null>(null);

    const metaMut = useFetchUrlMetadataMutation();
    const tagInputRef = useRef<HTMLInputElement>(null);

    function resetForm() {
        setUrl("");
        setTitle("");
        setDescription("");
        setFaviconUrl("");
        setTagInput("");
        setTags([]);
        setUrlError(null);
    }

    function handleOpenChange(value: boolean) {
        if (!value) {
            resetForm();
        }

        onOpenChange(value);
    }

    async function handleFetchMetadata() {
        setUrlError(null);
        try {
            const meta = await metaMut.mutateAsync(url.trim());
            if (meta.title && !title) {
                setTitle(meta.title);
            }

            if (meta.description && !description) {
                setDescription(meta.description);
            }

            if (meta.faviconUrl) {
                setFaviconUrl(meta.faviconUrl);
            }
        } catch (err) {
            setUrlError(err instanceof Error ? err.message : "Failed to fetch URL metadata");
        }
    }

    function addTag(value: string) {
        const cleaned = value.trim().toLowerCase().replace(/\s+/g, "-");
        if (cleaned && !tags.includes(cleaned)) {
            setTags([...tags, cleaned]);
        }

        setTagInput("");
    }

    function removeTag(tag: string) {
        setTags(tags.filter((t) => t !== tag));
    }

    function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(tagInput);
        } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
            setTags(tags.slice(0, -1));
        }
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!url.trim()) {
            setUrlError("URL is required");
            return;
        }

        try {
            new URL(url.trim());
        } catch {
            setUrlError("Please enter a valid URL");
            return;
        }

        setSubmitting(true);
        try {
            await onSubmit({
                url: url.trim(),
                title: title.trim() || url.trim(),
                description: description.trim(),
                faviconUrl: faviconUrl || undefined,
                tags,
            });
            handleOpenChange(false);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="bg-zinc-950/95 border-white/10 backdrop-blur-xl max-w-md">
                <DialogHeader>
                    <DialogTitle className="text-foreground/90">Save Bookmark</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
                    {/* URL field */}
                    <div>
                        <Label className={FIELD_LABEL}>URL</Label>
                        <div className="flex gap-2">
                            <Input
                                value={url}
                                onChange={(e) => {
                                    setUrl(e.target.value);
                                    setUrlError(null);
                                }}
                                placeholder="https://example.com"
                                className={cn(
                                    "flex-1 bg-white/5 border-white/10 focus:border-rose-500/50 focus:ring-rose-500/20",
                                    urlError && "border-rose-500/70"
                                )}
                                autoFocus
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={handleFetchMetadata}
                                disabled={!url.trim() || metaMut.isPending}
                                className="shrink-0 border-white/10 bg-white/5 hover:bg-rose-500/10 hover:border-rose-500/30 gap-1.5"
                            >
                                {metaMut.isPending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Sparkles className="h-3.5 w-3.5" />
                                )}
                                Auto-fill
                            </Button>
                        </div>
                        {urlError && <p className="mt-1 text-xs text-rose-400">{urlError}</p>}
                    </div>

                    {/* Title */}
                    <div>
                        <Label className={FIELD_LABEL}>Title</Label>
                        <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Page title"
                            className="bg-white/5 border-white/10 focus:border-rose-500/50 focus:ring-rose-500/20"
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <Label className={FIELD_LABEL}>Description</Label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="What is this about?"
                            rows={2}
                            className={cn(
                                "w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm",
                                "text-foreground placeholder:text-muted-foreground/50",
                                "focus:outline-none focus:border-rose-500/50 focus:ring-1 focus:ring-rose-500/20",
                                "resize-none transition-colors"
                            )}
                        />
                    </div>

                    {/* Tags */}
                    <div>
                        <Label className={FIELD_LABEL}>Tags</Label>
                        <div
                            className={cn(
                                "flex flex-wrap gap-1.5 min-h-[38px] w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5",
                                "focus-within:border-rose-500/50 focus-within:ring-1 focus-within:ring-rose-500/20 transition-colors",
                                "cursor-text"
                            )}
                            onClick={() => tagInputRef.current?.focus()}
                        >
                            {tags.map((tag) => (
                                <TagChip key={tag} onRemove={() => removeTag(tag)}>
                                    {tag}
                                </TagChip>
                            ))}
                            <input
                                ref={tagInputRef}
                                value={tagInput}
                                onChange={(e) => setTagInput(e.target.value)}
                                onKeyDown={handleTagKeyDown}
                                onBlur={() => {
                                    if (tagInput.trim()) {
                                        addTag(tagInput);
                                    }
                                }}
                                placeholder={tags.length === 0 ? "Add tags (comma or enter)" : ""}
                                className="flex-1 min-w-[80px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 outline-none"
                                list="existing-tags"
                            />
                            <datalist id="existing-tags">
                                {existingTags.map((t) => (
                                    <option key={t} value={t} />
                                ))}
                            </datalist>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => handleOpenChange(false)}
                            className="text-muted-foreground"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={submitting}
                            className="bg-rose-500 hover:bg-rose-600 text-white gap-2"
                        >
                            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                            Save Bookmark
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
