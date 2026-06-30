import { Input } from "@ui/components/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@ui/components/select";
import { FormDialog, FormField, TagChip } from "@ui/custom";
import { cn } from "@ui/lib/utils";
import type React from "react";
import { useRef, useState } from "react";
import type { ReadingItemInput, ReadingType } from "@/lib/reading/hooks/useReading";

interface ReadingFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: ReadingItemInput) => Promise<void>;
    existingTags: string[];
}

const TYPE_OPTIONS: { value: ReadingType; label: string }[] = [
    { value: "book", label: "Book" },
    { value: "article", label: "Article" },
    { value: "paper", label: "Paper" },
];

export function ReadingForm({ open, onOpenChange, onSubmit, existingTags }: ReadingFormProps) {
    const [title, setTitle] = useState("");
    const [author, setAuthor] = useState("");
    const [type, setType] = useState<ReadingType>("book");
    const [url, setUrl] = useState("");
    const [coverUrl, setCoverUrl] = useState("");
    const [totalPages, setTotalPages] = useState("");
    const [tagInput, setTagInput] = useState("");
    const [tags, setTags] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [titleError, setTitleError] = useState<string | null>(null);

    const tagInputRef = useRef<HTMLInputElement>(null);

    function resetForm() {
        setTitle("");
        setAuthor("");
        setType("book");
        setUrl("");
        setCoverUrl("");
        setTotalPages("");
        setTagInput("");
        setTags([]);
        setTitleError(null);
    }

    function handleOpenChange(value: boolean) {
        if (!value) {
            resetForm();
        }

        onOpenChange(value);
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

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!title.trim()) {
            setTitleError("Title is required");
            return;
        }

        setSubmitting(true);
        try {
            await onSubmit({
                title: title.trim(),
                author: author.trim(),
                type,
                url: url.trim() || undefined,
                coverUrl: coverUrl.trim() || undefined,
                totalPages: Number.parseInt(totalPages, 10) || 0,
                tags,
            });
            handleOpenChange(false);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <FormDialog
            open={open}
            onOpenChange={handleOpenChange}
            title="Add to Reading List"
            description="Track a book, article, or paper — with progress and highlights."
            onSubmit={handleSubmit}
            submitLabel="Add to shelf"
            isSubmitting={submitting}
            submitDisabled={!title.trim()}
        >
            <div className="grid gap-4">
                <FormField label="Title" required error={titleError}>
                    <Input
                        value={title}
                        onChange={(e) => {
                            setTitle(e.target.value);
                            setTitleError(null);
                        }}
                        placeholder="The Pragmatic Programmer"
                        autoFocus
                        data-testid="reading-title-input"
                    />
                </FormField>

                <div className="grid grid-cols-2 gap-4">
                    <FormField label="Author">
                        <Input
                            value={author}
                            onChange={(e) => setAuthor(e.target.value)}
                            placeholder="Hunt & Thomas"
                            data-testid="reading-author-input"
                        />
                    </FormField>
                    <FormField label="Type">
                        <Select value={type} onValueChange={(v) => setType(v as ReadingType)}>
                            <SelectTrigger data-testid="reading-type-select">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {TYPE_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </FormField>
                </div>

                <FormField label="URL" hint="Link to the source (optional)">
                    <Input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://…"
                        data-testid="reading-url-input"
                    />
                </FormField>

                <div className="grid grid-cols-2 gap-4">
                    <FormField label="Total pages">
                        <Input
                            type="number"
                            min={0}
                            value={totalPages}
                            onChange={(e) => setTotalPages(e.target.value)}
                            placeholder="352"
                            data-testid="reading-total-pages-input"
                        />
                    </FormField>
                    <FormField label="Cover URL" hint="Leave blank for a generated cover">
                        <Input
                            value={coverUrl}
                            onChange={(e) => setCoverUrl(e.target.value)}
                            placeholder="https://…/cover.jpg"
                            data-testid="reading-cover-input"
                        />
                    </FormField>
                </div>

                <FormField label="Tags">
                    <div
                        className={cn(
                            "flex min-h-[38px] w-full cursor-text flex-wrap gap-1.5 rounded-md border border-input bg-input/30 px-2.5 py-1.5",
                            "transition-colors focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30"
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
                            className="min-w-[80px] flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
                            list="reading-existing-tags"
                            data-testid="reading-tags-input"
                        />
                        <datalist id="reading-existing-tags">
                            {existingTags.map((t) => (
                                <option key={t} value={t} />
                            ))}
                        </datalist>
                    </div>
                </FormField>
            </div>
        </FormDialog>
    );
}
