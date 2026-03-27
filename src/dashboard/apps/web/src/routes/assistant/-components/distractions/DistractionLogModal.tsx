import { AlertCircle, Coffee, Mail, MessageSquare, User, Users, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { DistractionSource, Task } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface DistractionLogModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onLog: (source: DistractionSource, description?: string, taskInterrupted?: string) => Promise<void>;
    currentTask?: Task | null;
    loading?: boolean;
}

/**
 * Source configuration with icons and colors
 */
const sourceConfig: Record<
    DistractionSource,
    {
        icon: typeof MessageSquare;
        label: string;
        color: string;
        bgColor: string;
        borderColor: string;
        shadowColor: string;
    }
> = {
    slack: {
        icon: MessageSquare,
        label: "Slack/Chat",
        color: "text-cyan-400",
        bgColor: "bg-cyan-500/10",
        borderColor: "border-cyan-500/30",
        shadowColor: "shadow-cyan-500/20",
    },
    email: {
        icon: Mail,
        label: "Email",
        color: "text-blue-400",
        bgColor: "bg-blue-500/10",
        borderColor: "border-blue-500/30",
        shadowColor: "shadow-blue-500/20",
    },
    meeting: {
        icon: Users,
        label: "Unplanned Meeting",
        color: "text-orange-400",
        bgColor: "bg-orange-500/10",
        borderColor: "border-orange-500/30",
        shadowColor: "shadow-orange-500/20",
    },
    coworker: {
        icon: User,
        label: "Coworker",
        color: "text-purple-400",
        bgColor: "bg-purple-500/10",
        borderColor: "border-purple-500/30",
        shadowColor: "shadow-purple-500/20",
    },
    hunger: {
        icon: Coffee,
        label: "Hunger/Break",
        color: "text-amber-400",
        bgColor: "bg-amber-500/10",
        borderColor: "border-amber-500/30",
        shadowColor: "shadow-amber-500/20",
    },
    other: {
        icon: AlertCircle,
        label: "Other",
        color: "text-gray-400",
        bgColor: "bg-gray-500/10",
        borderColor: "border-gray-500/30",
        shadowColor: "shadow-gray-500/20",
    },
};

const sources: DistractionSource[] = ["slack", "email", "meeting", "coworker", "hunger", "other"];

/**
 * DistractionLogModal - Modal to log a new distraction
 *
 * Features:
 * - Source selector with neon-colored icons
 * - Optional description
 * - Auto-fills interrupted task if one is in progress
 */
export function DistractionLogModal({
    open,
    onOpenChange,
    onLog,
    currentTask,
    loading = false,
}: DistractionLogModalProps) {
    const [selectedSource, setSelectedSource] = useState<DistractionSource | null>(null);
    const [description, setDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Reset state when modal closes
    useEffect(() => {
        if (!open) {
            setSelectedSource(null);
            setDescription("");
        }
    }, [open]);

    async function handleSubmit() {
        if (!selectedSource) {
            return;
        }

        setIsSubmitting(true);
        try {
            await onLog(selectedSource, description.trim() || undefined, currentTask?.id);
            onOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    }

    function handleQuickLog(source: DistractionSource) {
        setSelectedSource(source);
        // Auto-submit after a brief delay for quick logging
        setTimeout(() => {
            if (!description.trim()) {
                onLog(source, undefined, currentTask?.id).then(() => {
                    onOpenChange(false);
                });
            }
        }, 150);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md bg-[#0a0a14]/95 border-cyan-500/20">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Zap className="h-5 w-5 text-cyan-400" />
                        Log Distraction
                    </DialogTitle>
                    <DialogDescription>What interrupted your focus?</DialogDescription>
                </DialogHeader>

                {/* Source selector grid */}
                <div className="grid grid-cols-3 gap-3 py-4">
                    {sources.map((source) => {
                        const config = sourceConfig[source];
                        const Icon = config.icon;
                        const isSelected = selectedSource === source;

                        return (
                            <button
                                key={source}
                                type="button"
                                onClick={() => setSelectedSource(source)}
                                onDoubleClick={() => handleQuickLog(source)}
                                className={cn(
                                    "flex flex-col items-center justify-center gap-2 p-4 rounded-lg",
                                    "border transition-all duration-200",
                                    "hover:scale-105 cursor-pointer",
                                    isSelected
                                        ? cn(config.bgColor, config.borderColor, "shadow-lg", config.shadowColor)
                                        : "bg-white/5 border-white/10 hover:border-white/20"
                                )}
                                style={
                                    isSelected
                                        ? {
                                              boxShadow: `0 0 20px ${
                                                  source === "slack"
                                                      ? "rgba(6, 182, 212, 0.3)"
                                                      : source === "email"
                                                        ? "rgba(59, 130, 246, 0.3)"
                                                        : source === "meeting"
                                                          ? "rgba(249, 115, 22, 0.3)"
                                                          : source === "coworker"
                                                            ? "rgba(168, 85, 247, 0.3)"
                                                            : source === "hunger"
                                                              ? "rgba(245, 158, 11, 0.3)"
                                                              : "rgba(156, 163, 175, 0.3)"
                                              }`,
                                          }
                                        : undefined
                                }
                            >
                                <Icon
                                    className={cn(
                                        "h-6 w-6 transition-colors",
                                        isSelected ? config.color : "text-muted-foreground"
                                    )}
                                />
                                <span
                                    className={cn(
                                        "text-xs font-medium text-center",
                                        isSelected ? config.color : "text-muted-foreground"
                                    )}
                                >
                                    {config.label}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {/* Optional description */}
                <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">What happened? (optional)</label>
                    <Textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="e.g., Urgent bug report from support..."
                        className="resize-none bg-white/5 border-white/10 focus:border-cyan-500/50"
                        rows={2}
                    />
                </div>

                {/* Current task indicator */}
                {currentTask && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                        <div className="h-2 w-2 rounded-full bg-purple-400 animate-pulse" />
                        <span className="text-xs text-purple-300">
                            Interrupted: <span className="font-medium">{currentTask.title}</span>
                        </span>
                    </div>
                )}

                <DialogFooter className="gap-2">
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting || loading}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleSubmit}
                        disabled={!selectedSource || isSubmitting || loading}
                        className="bg-cyan-600 hover:bg-cyan-700 text-white"
                    >
                        {isSubmitting ? "Logging..." : "Log Distraction"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export { sourceConfig };
