import { Calendar, Github, Link, Mail, MessageSquare, Pencil, Plus, Tag, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
    CommunicationEntry,
    CommunicationEntryInput,
    CommunicationSentiment,
    CommunicationSource,
} from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface LogFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: CommunicationEntryInput) => Promise<void>;
    initialValues?: Partial<CommunicationEntry>;
    isEdit?: boolean;
    existingTags?: string[];
}

/**
 * Source selector button component
 */
function SourceButton({
    source,
    selected,
    onClick,
}: {
    source: CommunicationSource;
    selected: boolean;
    onClick: () => void;
}) {
    const config: Record<
        CommunicationSource,
        {
            label: string;
            icon: typeof MessageSquare;
            color: string;
            bg: string;
            border: string;
            activeBorder: string;
            hoverBg: string;
        }
    > = {
        slack: {
            label: "Slack",
            icon: MessageSquare,
            color: "text-purple-400",
            bg: "bg-purple-500/10",
            border: "border-purple-500/30",
            activeBorder: "border-purple-500",
            hoverBg: "hover:bg-purple-500/20",
        },
        github: {
            label: "GitHub",
            icon: Github,
            color: "text-gray-400",
            bg: "bg-gray-500/10",
            border: "border-gray-500/30",
            activeBorder: "border-gray-500",
            hoverBg: "hover:bg-gray-500/20",
        },
        email: {
            label: "Email",
            icon: Mail,
            color: "text-blue-400",
            bg: "bg-blue-500/10",
            border: "border-blue-500/30",
            activeBorder: "border-blue-500",
            hoverBg: "hover:bg-blue-500/20",
        },
        meeting: {
            label: "Meeting",
            icon: Users,
            color: "text-emerald-400",
            bg: "bg-emerald-500/10",
            border: "border-emerald-500/30",
            activeBorder: "border-emerald-500",
            hoverBg: "hover:bg-emerald-500/20",
        },
        manual: {
            label: "Manual",
            icon: Pencil,
            color: "text-amber-400",
            bg: "bg-amber-500/10",
            border: "border-amber-500/30",
            activeBorder: "border-amber-500",
            hoverBg: "hover:bg-amber-500/20",
        },
    };

    const c = config[source];
    const Icon = c.icon;

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex flex-col items-center justify-center p-3 rounded-lg border-2 transition-all",
                c.bg,
                selected ? c.activeBorder : c.border,
                c.hoverBg,
                selected && "ring-2 ring-offset-2 ring-offset-background ring-white/10"
            )}
        >
            <Icon className={cn("h-5 w-5 mb-1", c.color)} />
            <span className={cn("text-xs font-medium", c.color)}>{c.label}</span>
        </button>
    );
}

/**
 * Sentiment selector button component
 */
function SentimentButton({
    sentiment,
    selected,
    onClick,
}: {
    sentiment: CommunicationSentiment;
    selected: boolean;
    onClick: () => void;
}) {
    const config: Record<
        CommunicationSentiment,
        {
            label: string;
            description: string;
            color: string;
            bg: string;
            border: string;
            activeBorder: string;
        }
    > = {
        decision: {
            label: "Decision",
            description: "A choice was made",
            color: "text-purple-400",
            bg: "bg-purple-500/10",
            border: "border-purple-500/30",
            activeBorder: "border-purple-500",
        },
        discussion: {
            label: "Discussion",
            description: "Ongoing conversation",
            color: "text-blue-400",
            bg: "bg-blue-500/10",
            border: "border-blue-500/30",
            activeBorder: "border-blue-500",
        },
        blocker: {
            label: "Blocker",
            description: "Something is blocked",
            color: "text-red-400",
            bg: "bg-red-500/10",
            border: "border-red-500/30",
            activeBorder: "border-red-500",
        },
        context: {
            label: "Context",
            description: "Background info",
            color: "text-gray-400",
            bg: "bg-gray-500/10",
            border: "border-gray-500/30",
            activeBorder: "border-gray-500",
        },
    };

    const c = config[sentiment];

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex-1 p-2 rounded-lg border-2 transition-all text-left",
                c.bg,
                selected ? c.activeBorder : c.border,
                "hover:opacity-80",
                selected && "ring-1 ring-offset-1 ring-offset-background ring-white/10"
            )}
        >
            <span className={cn("text-xs font-semibold", c.color)}>{c.label}</span>
            <p className="text-[10px] text-muted-foreground mt-0.5">{c.description}</p>
        </button>
    );
}

/**
 * LogForm component - Modal form for creating/editing communication entries
 */
export function LogForm({
    open,
    onOpenChange,
    onSubmit,
    initialValues,
    isEdit = false,
    existingTags = [],
}: LogFormProps) {
    const [source, setSource] = useState<CommunicationSource>(initialValues?.source ?? "manual");
    const [title, setTitle] = useState(initialValues?.title ?? "");
    const [content, setContent] = useState(initialValues?.content ?? "");
    const [sourceUrl, setSourceUrl] = useState(initialValues?.sourceUrl ?? "");
    const [discussedAt, setDiscussedAt] = useState(
        initialValues?.discussedAt
            ? formatDateForInput(new Date(initialValues.discussedAt))
            : formatDateForInput(new Date())
    );
    const [sentiment, setSentiment] = useState<CommunicationSentiment>(initialValues?.sentiment ?? "context");
    const [tags, setTags] = useState<string[]>(initialValues?.tags ?? []);
    const [tagInput, setTagInput] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    function formatDateForInput(date: Date): string {
        const d = new Date(date);
        return d.toISOString().split("T")[0];
    }

    // Reset form when dialog opens
    useEffect(() => {
        if (open) {
            setSource(initialValues?.source ?? "manual");
            setTitle(initialValues?.title ?? "");
            setContent(initialValues?.content ?? "");
            setSourceUrl(initialValues?.sourceUrl ?? "");
            setDiscussedAt(
                initialValues?.discussedAt
                    ? formatDateForInput(new Date(initialValues.discussedAt))
                    : formatDateForInput(new Date())
            );
            setSentiment(initialValues?.sentiment ?? "context");
            setTags(initialValues?.tags ?? []);
            setTagInput("");
        }
    }, [open, initialValues, formatDateForInput]);

    function handleAddTag() {
        const trimmed = tagInput.trim().toLowerCase();
        if (trimmed && !tags.includes(trimmed)) {
            setTags([...tags, trimmed]);
            setTagInput("");
        }
    }

    function handleRemoveTag(tag: string) {
        setTags(tags.filter((t) => t !== tag));
    }

    function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter") {
            e.preventDefault();
            handleAddTag();
        }
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        if (!title.trim() || !content.trim()) {
            return;
        }

        setIsSubmitting(true);
        try {
            await onSubmit({
                source,
                title: title.trim(),
                content: content.trim(),
                sourceUrl: sourceUrl.trim() || undefined,
                discussedAt: new Date(discussedAt),
                sentiment,
                tags,
            });
            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    }

    // Filter existing tags for suggestions
    const tagSuggestions = existingTags
        .filter((t) => !tags.includes(t) && t.includes(tagInput.toLowerCase()))
        .slice(0, 5);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[550px] bg-card border-border/50 max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-xl">{isEdit ? "Edit Entry" : "Log Communication"}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {/* Source selector */}
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Source</Label>
                        <div className="grid grid-cols-5 gap-2">
                            <SourceButton
                                source="slack"
                                selected={source === "slack"}
                                onClick={() => setSource("slack")}
                            />
                            <SourceButton
                                source="github"
                                selected={source === "github"}
                                onClick={() => setSource("github")}
                            />
                            <SourceButton
                                source="email"
                                selected={source === "email"}
                                onClick={() => setSource("email")}
                            />
                            <SourceButton
                                source="meeting"
                                selected={source === "meeting"}
                                onClick={() => setSource("meeting")}
                            />
                            <SourceButton
                                source="manual"
                                selected={source === "manual"}
                                onClick={() => setSource("manual")}
                            />
                        </div>
                    </div>

                    {/* Title */}
                    <div className="space-y-2">
                        <Label htmlFor="title" className="text-sm font-medium">
                            Title <span className="text-red-400">*</span>
                        </Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                            placeholder="Brief summary of the communication"
                            className="bg-background/50"
                            autoFocus
                        />
                    </div>

                    {/* Content */}
                    <div className="space-y-2">
                        <Label htmlFor="content" className="text-sm font-medium">
                            Content <span className="text-red-400">*</span>
                        </Label>
                        <Textarea
                            id="content"
                            value={content}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
                            placeholder="Key points, quotes, or details worth remembering..."
                            className="bg-background/50 min-h-[100px] resize-none"
                        />
                    </div>

                    {/* Sentiment selector */}
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Type</Label>
                        <div className="grid grid-cols-4 gap-2">
                            <SentimentButton
                                sentiment="decision"
                                selected={sentiment === "decision"}
                                onClick={() => setSentiment("decision")}
                            />
                            <SentimentButton
                                sentiment="discussion"
                                selected={sentiment === "discussion"}
                                onClick={() => setSentiment("discussion")}
                            />
                            <SentimentButton
                                sentiment="blocker"
                                selected={sentiment === "blocker"}
                                onClick={() => setSentiment("blocker")}
                            />
                            <SentimentButton
                                sentiment="context"
                                selected={sentiment === "context"}
                                onClick={() => setSentiment("context")}
                            />
                        </div>
                    </div>

                    {/* Source URL */}
                    <div className="space-y-2">
                        <Label htmlFor="sourceUrl" className="text-sm font-medium">
                            Source Link
                        </Label>
                        <div className="relative">
                            <Link className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="sourceUrl"
                                value={sourceUrl}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSourceUrl(e.target.value)}
                                placeholder="https://..."
                                className="bg-background/50 pl-10"
                            />
                        </div>
                    </div>

                    {/* Date */}
                    <div className="space-y-2">
                        <Label htmlFor="discussedAt" className="text-sm font-medium">
                            Date
                        </Label>
                        <div className="relative">
                            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="discussedAt"
                                type="date"
                                value={discussedAt}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDiscussedAt(e.target.value)}
                                className="bg-background/50 pl-10"
                            />
                        </div>
                    </div>

                    {/* Tags */}
                    <div className="space-y-2">
                        <Label htmlFor="tags" className="text-sm font-medium">
                            Tags
                        </Label>
                        <div className="relative">
                            <Tag className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="tags"
                                value={tagInput}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTagInput(e.target.value)}
                                onKeyDown={handleTagKeyDown}
                                placeholder="Add tags (press Enter)"
                                className="bg-background/50 pl-10 pr-10"
                            />
                            {tagInput.trim() && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={handleAddTag}
                                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                                >
                                    <Plus className="h-4 w-4" />
                                </Button>
                            )}
                        </div>

                        {/* Tag suggestions */}
                        {tagSuggestions.length > 0 && tagInput.trim() && (
                            <div className="flex flex-wrap gap-1">
                                {tagSuggestions.map((tag) => (
                                    <button
                                        key={tag}
                                        type="button"
                                        onClick={() => {
                                            setTags([...tags, tag]);
                                            setTagInput("");
                                        }}
                                        className="text-[10px] px-2 py-0.5 rounded bg-white/5 border border-white/10 text-muted-foreground hover:bg-white/10 transition-colors"
                                    >
                                        + {tag}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Selected tags */}
                        {tags.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                                {tags.map((tag) => (
                                    <Badge
                                        key={tag}
                                        variant="outline"
                                        className="text-xs px-2 py-0.5 bg-white/5 border-white/20 gap-1"
                                    >
                                        {tag}
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveTag(tag)}
                                            className="hover:text-red-400 transition-colors"
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </div>

                    <DialogFooter className="pt-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={isSubmitting}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!title.trim() || !content.trim() || isSubmitting}
                            className="bg-purple-600 hover:bg-purple-700"
                        >
                            {isSubmitting ? "Saving..." : isEdit ? "Save Changes" : "Log Entry"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
