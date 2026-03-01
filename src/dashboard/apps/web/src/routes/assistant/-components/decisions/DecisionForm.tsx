import { Calendar, Plus, Scale, Tag, User, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { DecisionImpactArea, DecisionInput, Task } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface DecisionFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: DecisionInput) => Promise<void>;
    initialValues?: Partial<DecisionInput>;
    isEdit?: boolean;
    tasks?: Task[]; // For linking to tasks
    existingTags?: string[]; // Autocomplete suggestions
}

/**
 * Impact area options configuration
 */
const impactAreaOptions: { value: DecisionImpactArea; label: string; color: string }[] = [
    { value: "frontend", label: "Frontend", color: "text-purple-400" },
    { value: "backend", label: "Backend", color: "text-blue-400" },
    { value: "infrastructure", label: "Infrastructure", color: "text-orange-400" },
    { value: "process", label: "Process", color: "text-cyan-400" },
    { value: "architecture", label: "Architecture", color: "text-amber-400" },
    { value: "product", label: "Product", color: "text-emerald-400" },
];

/**
 * Format date for input field
 */
function formatDateForInput(date: Date): string {
    const d = new Date(date);
    return d.toISOString().split("T")[0];
}

/**
 * DecisionForm component - Modal form for creating/editing decisions
 */
export function DecisionForm({
    open,
    onOpenChange,
    onSubmit,
    initialValues,
    isEdit = false,
    tasks = [],
    existingTags = [],
}: DecisionFormProps) {
    const [title, setTitle] = useState(initialValues?.title ?? "");
    const [reasoning, setReasoning] = useState(initialValues?.reasoning ?? "");
    const [alternatives, setAlternatives] = useState<string[]>(initialValues?.alternativesConsidered ?? []);
    const [newAlternative, setNewAlternative] = useState("");
    const [impactArea, setImpactArea] = useState<DecisionImpactArea>(initialValues?.impactArea ?? "frontend");
    const [decidedBy, setDecidedBy] = useState(initialValues?.decidedBy ?? "");
    const [decidedAt, setDecidedAt] = useState(
        initialValues?.decidedAt ? formatDateForInput(initialValues.decidedAt) : formatDateForInput(new Date())
    );
    const [relatedTaskIds, setRelatedTaskIds] = useState<string[]>(initialValues?.relatedTaskIds ?? []);
    const [tagsInput, setTagsInput] = useState(initialValues?.tags?.join(", ") ?? "");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Reset form when dialog opens/closes or initialValues change
    useEffect(() => {
        if (open) {
            setTitle(initialValues?.title ?? "");
            setReasoning(initialValues?.reasoning ?? "");
            setAlternatives(initialValues?.alternativesConsidered ?? []);
            setNewAlternative("");
            setImpactArea(initialValues?.impactArea ?? "frontend");
            setDecidedBy(initialValues?.decidedBy ?? "");
            setDecidedAt(
                initialValues?.decidedAt ? formatDateForInput(initialValues.decidedAt) : formatDateForInput(new Date())
            );
            setRelatedTaskIds(initialValues?.relatedTaskIds ?? []);
            setTagsInput(initialValues?.tags?.join(", ") ?? "");
        }
    }, [open, initialValues]);

    function addAlternative() {
        if (newAlternative.trim()) {
            setAlternatives([...alternatives, newAlternative.trim()]);
            setNewAlternative("");
        }
    }

    function removeAlternative(index: number) {
        setAlternatives(alternatives.filter((_, i) => i !== index));
    }

    function toggleTaskLink(taskId: string) {
        if (relatedTaskIds.includes(taskId)) {
            setRelatedTaskIds(relatedTaskIds.filter((id) => id !== taskId));
        } else {
            setRelatedTaskIds([...relatedTaskIds, taskId]);
        }
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        if (!title.trim() || !reasoning.trim() || !impactArea) {
            return;
        }

        setIsSubmitting(true);
        try {
            const tags = tagsInput
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0);

            await onSubmit({
                title: title.trim(),
                reasoning: reasoning.trim(),
                alternativesConsidered: alternatives,
                impactArea,
                decidedBy: decidedBy.trim() || undefined,
                decidedAt: decidedAt ? new Date(decidedAt) : undefined,
                relatedTaskIds,
                tags,
            });

            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[600px] bg-card border-border/50 max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="text-xl flex items-center gap-2">
                        <Scale className="h-5 w-5 text-purple-400" />
                        {isEdit ? "Edit Decision" : "Record New Decision"}
                    </DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {/* Title */}
                    <div className="space-y-2">
                        <Label htmlFor="title" className="text-sm font-medium">
                            Decision Title <span className="text-red-400">*</span>
                        </Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                            placeholder="What decision was made?"
                            className="bg-background/50"
                            autoFocus
                        />
                    </div>

                    {/* Reasoning */}
                    <div className="space-y-2">
                        <Label htmlFor="reasoning" className="text-sm font-medium">
                            Reasoning <span className="text-red-400">*</span>
                        </Label>
                        <Textarea
                            id="reasoning"
                            value={reasoning}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReasoning(e.target.value)}
                            placeholder="Why was this decision made? What factors were considered?"
                            className="bg-background/50 min-h-[100px] resize-none"
                        />
                    </div>

                    {/* Alternatives considered */}
                    <div className="space-y-2">
                        <Label className="text-sm font-medium">Alternatives Considered</Label>

                        {/* List of alternatives */}
                        {alternatives.length > 0 && (
                            <ul className="space-y-2 mb-3">
                                {alternatives.map((alt, index) => (
                                    <li
                                        key={index}
                                        className="flex items-center gap-2 p-2 rounded-lg bg-white/5 border border-white/10"
                                    >
                                        <span className="flex-1 text-sm">{alt}</span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0 hover:bg-red-500/20 hover:text-red-400"
                                            onClick={() => removeAlternative(index)}
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {/* Add alternative input */}
                        <div className="flex gap-2">
                            <Input
                                value={newAlternative}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewAlternative(e.target.value)}
                                placeholder="Add an alternative that was considered"
                                className="bg-background/50 flex-1"
                                onKeyDown={(e: React.KeyboardEvent) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        addAlternative();
                                    }
                                }}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={addAlternative}
                                disabled={!newAlternative.trim()}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {/* Impact area & date row */}
                    <div className="grid grid-cols-2 gap-4">
                        {/* Impact area */}
                        <div className="space-y-2">
                            <Label className="text-sm font-medium">
                                Impact Area <span className="text-red-400">*</span>
                            </Label>
                            <Select value={impactArea} onValueChange={(v: DecisionImpactArea) => setImpactArea(v)}>
                                <SelectTrigger className="bg-background/50">
                                    <SelectValue placeholder="Select area" />
                                </SelectTrigger>
                                <SelectContent>
                                    {impactAreaOptions.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            <span className={option.color}>{option.label}</span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Decision date */}
                        <div className="space-y-2">
                            <Label htmlFor="decidedAt" className="text-sm font-medium">
                                Decision Date
                            </Label>
                            <div className="relative">
                                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    id="decidedAt"
                                    type="date"
                                    value={decidedAt}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDecidedAt(e.target.value)}
                                    className="bg-background/50 pl-10"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Decided by */}
                    <div className="space-y-2">
                        <Label htmlFor="decidedBy" className="text-sm font-medium">
                            Decided By
                        </Label>
                        <div className="relative">
                            <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="decidedBy"
                                value={decidedBy}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDecidedBy(e.target.value)}
                                placeholder="Who made this decision?"
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
                                value={tagsInput}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTagsInput(e.target.value)}
                                placeholder="Comma-separated tags (e.g., tech-debt, security)"
                                className="bg-background/50 pl-10"
                            />
                        </div>
                        {existingTags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                                <span className="text-xs text-muted-foreground mr-1">Suggestions:</span>
                                {existingTags.slice(0, 8).map((tag) => (
                                    <button
                                        key={tag}
                                        type="button"
                                        onClick={() => {
                                            const currentTags = tagsInput
                                                .split(",")
                                                .map((t) => t.trim())
                                                .filter(Boolean);
                                            if (!currentTags.includes(tag)) {
                                                setTagsInput(currentTags.length > 0 ? `${tagsInput}, ${tag}` : tag);
                                            }
                                        }}
                                        className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-muted-foreground hover:bg-white/10 hover:text-foreground transition-colors"
                                    >
                                        {tag}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Related tasks */}
                    {tasks.length > 0 && (
                        <div className="space-y-2">
                            <Label className="text-sm font-medium">Link to Tasks</Label>
                            <div className="max-h-[150px] overflow-y-auto space-y-1 rounded-lg border border-white/10 p-2 bg-background/30">
                                {tasks
                                    .filter((t) => t.status !== "completed")
                                    .map((task) => (
                                        <button
                                            key={task.id}
                                            type="button"
                                            onClick={() => toggleTaskLink(task.id)}
                                            className={cn(
                                                "w-full text-left p-2 rounded-lg text-sm transition-colors",
                                                relatedTaskIds.includes(task.id)
                                                    ? "bg-purple-500/20 border border-purple-500/30 text-purple-300"
                                                    : "hover:bg-white/5"
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <div
                                                    className={cn(
                                                        "h-3 w-3 rounded-full border-2 flex items-center justify-center",
                                                        relatedTaskIds.includes(task.id)
                                                            ? "border-purple-400 bg-purple-400"
                                                            : "border-white/30"
                                                    )}
                                                >
                                                    {relatedTaskIds.includes(task.id) && (
                                                        <div className="h-1.5 w-1.5 rounded-full bg-white" />
                                                    )}
                                                </div>
                                                <span className="truncate">{task.title}</span>
                                            </div>
                                        </button>
                                    ))}
                            </div>
                            {relatedTaskIds.length > 0 && (
                                <p className="text-xs text-muted-foreground">
                                    {relatedTaskIds.length} task{relatedTaskIds.length !== 1 ? "s" : ""} selected
                                </p>
                            )}
                        </div>
                    )}

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
                            disabled={!title.trim() || !reasoning.trim() || isSubmitting}
                            className="bg-purple-600 hover:bg-purple-700"
                        >
                            {isSubmitting ? "Saving..." : isEdit ? "Save Changes" : "Record Decision"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
