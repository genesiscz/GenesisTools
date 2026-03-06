import { AlertCircle, AlertTriangle, Calendar, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TaskInput, UrgencyLevel } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface TaskFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: TaskInput) => Promise<void>;
    initialValues?: Partial<TaskInput>;
    isEdit?: boolean;
}

/**
 * Urgency selector button component
 */
function UrgencyButton({
    urgency,
    selected,
    onClick,
}: {
    urgency: UrgencyLevel;
    selected: boolean;
    onClick: () => void;
}) {
    const config = {
        critical: {
            label: "Critical",
            description: "Blocks shipping / major impact",
            icon: AlertTriangle,
            color: "text-red-400",
            bg: "bg-red-500/10",
            border: "border-red-500/30",
            activeBorder: "border-red-500",
            hoverBg: "hover:bg-red-500/20",
        },
        important: {
            label: "Important",
            description: "Should hit deadline",
            icon: AlertCircle,
            color: "text-orange-400",
            bg: "bg-orange-500/10",
            border: "border-orange-500/30",
            activeBorder: "border-orange-500",
            hoverBg: "hover:bg-orange-500/20",
        },
        "nice-to-have": {
            label: "Nice to Have",
            description: "Flexible deadline",
            icon: Sparkles,
            color: "text-yellow-400",
            bg: "bg-yellow-500/10",
            border: "border-yellow-500/30",
            activeBorder: "border-yellow-500",
            hoverBg: "hover:bg-yellow-500/20",
        },
    };

    const c = config[urgency];
    const Icon = c.icon;

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex-1 p-3 rounded-lg border-2 transition-all text-left",
                c.bg,
                selected ? c.activeBorder : c.border,
                c.hoverBg,
                selected && "ring-2 ring-offset-2 ring-offset-background",
                urgency === "critical" && selected && "ring-red-500/50",
                urgency === "important" && selected && "ring-orange-500/50",
                urgency === "nice-to-have" && selected && "ring-yellow-500/50"
            )}
        >
            <div className="flex items-center gap-2 mb-1">
                <Icon className={cn("h-4 w-4", c.color)} />
                <span className={cn("font-semibold text-sm", c.color)}>{c.label}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{c.description}</p>
        </button>
    );
}

/**
 * TaskForm component - Modal form for creating/editing tasks
 */
export function TaskForm({ open, onOpenChange, onSubmit, initialValues, isEdit = false }: TaskFormProps) {
    const [title, setTitle] = useState(initialValues?.title ?? "");
    const [description, setDescription] = useState(initialValues?.description ?? "");
    const [urgency, setUrgency] = useState<UrgencyLevel>(initialValues?.urgencyLevel ?? "nice-to-have");
    const [deadline, setDeadline] = useState(initialValues?.deadline ? formatDateForInput(initialValues.deadline) : "");
    const [isShippingBlocker, setIsShippingBlocker] = useState(initialValues?.isShippingBlocker ?? false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    function formatDateForInput(date: Date): string {
        const d = new Date(date);
        return d.toISOString().split("T")[0];
    }

    function resetForm() {
        setTitle(initialValues?.title ?? "");
        setDescription(initialValues?.description ?? "");
        setUrgency(initialValues?.urgencyLevel ?? "nice-to-have");
        setDeadline(initialValues?.deadline ? formatDateForInput(initialValues.deadline) : "");
        setIsShippingBlocker(initialValues?.isShippingBlocker ?? false);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        if (!title.trim()) {
            return;
        }

        setIsSubmitting(true);
        try {
            await onSubmit({
                title: title.trim(),
                description: description.trim() || undefined,
                urgencyLevel: urgency,
                deadline: deadline ? new Date(deadline) : undefined,
                isShippingBlocker,
            });

            if (!isEdit) {
                resetForm();
            }
            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    }

    function handleOpenChange(newOpen: boolean) {
        if (!newOpen) {
            resetForm();
        }
        onOpenChange(newOpen);
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[500px] bg-card border-border/50">
                <DialogHeader>
                    <DialogTitle className="text-xl">{isEdit ? "Edit Task" : "Create New Task"}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {/* Title */}
                    <div className="space-y-2">
                        <Label htmlFor="title" className="text-sm font-medium">
                            Task Title <span className="text-red-400">*</span>
                        </Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                            placeholder="What needs to be done?"
                            className="bg-background/50"
                            autoFocus
                        />
                    </div>

                    {/* Description */}
                    <div className="space-y-2">
                        <Label htmlFor="description" className="text-sm font-medium">
                            Description
                        </Label>
                        <Textarea
                            id="description"
                            value={description}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                            placeholder="Add more details (optional)"
                            className="bg-background/50 min-h-[80px] resize-none"
                        />
                    </div>

                    {/* Urgency selector */}
                    <div className="space-y-3">
                        <Label className="text-sm font-medium">How urgent is this?</Label>
                        <div className="flex gap-2">
                            <UrgencyButton
                                urgency="critical"
                                selected={urgency === "critical"}
                                onClick={() => setUrgency("critical")}
                            />
                            <UrgencyButton
                                urgency="important"
                                selected={urgency === "important"}
                                onClick={() => setUrgency("important")}
                            />
                            <UrgencyButton
                                urgency="nice-to-have"
                                selected={urgency === "nice-to-have"}
                                onClick={() => setUrgency("nice-to-have")}
                            />
                        </div>
                    </div>

                    {/* Deadline */}
                    <div className="space-y-2">
                        <Label htmlFor="deadline" className="text-sm font-medium">
                            Deadline
                        </Label>
                        <div className="relative">
                            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                id="deadline"
                                type="date"
                                value={deadline}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeadline(e.target.value)}
                                className="bg-background/50 pl-10"
                            />
                            {deadline && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                                    onClick={() => setDeadline("")}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Shipping blocker toggle */}
                    {urgency === "critical" && (
                        <div className="flex items-center gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                            <input
                                type="checkbox"
                                id="shipping-blocker"
                                checked={isShippingBlocker}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                    setIsShippingBlocker(e.target.checked)
                                }
                                className="h-4 w-4 rounded border-red-500/50 bg-transparent text-red-500 focus:ring-red-500/50"
                            />
                            <Label htmlFor="shipping-blocker" className="text-sm text-red-300 cursor-pointer">
                                This blocks shipping / deployment
                            </Label>
                        </div>
                    )}

                    <DialogFooter className="pt-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => handleOpenChange(false)}
                            disabled={isSubmitting}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={!title.trim() || isSubmitting}
                            className="bg-purple-600 hover:bg-purple-700"
                        >
                            {isSubmitting ? "Saving..." : isEdit ? "Save Changes" : "Create Task"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
