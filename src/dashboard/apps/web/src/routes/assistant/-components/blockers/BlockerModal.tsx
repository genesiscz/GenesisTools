import { Button } from "@ui/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { FormField, SelectorButton } from "@ui/custom";
import { AlertTriangle, ArrowRight, Ban, Bell, ListTodo, Timer, User } from "lucide-react";
import { useState } from "react";
import type { BlockerFollowUpAction, Task, TaskBlockerInput } from "@/lib/assistant/types";

interface BlockerModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    task: Task | null;
    eligibleTasks?: Task[];
    onSubmit: (input: TaskBlockerInput) => Promise<void>;
}

/**
 * Follow-up action configuration
 */
const followUpActions: {
    value: BlockerFollowUpAction;
    label: string;
    description: string;
    icon: React.ReactNode;
    selectedClass: string;
}[] = [
    {
        value: "remind",
        label: "Remind Owner",
        description: "Follow up with someone",
        icon: <Bell className="h-4 w-4" />,
        selectedClass: "border-blue-500 bg-blue-500/10 text-blue-300",
    },
    {
        value: "switch",
        label: "Switch Task",
        description: "Work on something else",
        icon: <ArrowRight className="h-4 w-4" />,
        selectedClass: "border-purple-500 bg-purple-500/10 text-purple-300",
    },
    {
        value: "wait",
        label: "Wait",
        description: "Nothing to do but wait",
        icon: <Timer className="h-4 w-4" />,
        selectedClass: "border-amber-500 bg-amber-500/10 text-amber-300",
    },
];

/**
 * BlockerModal - Dialog for marking a task as blocked
 *
 * Captures:
 * - Blocker reason (required)
 * - Blocker owner (optional, e.g., "@sarah")
 * - Follow-up action (remind/switch/wait)
 */
export function BlockerModal({ open, onOpenChange, task, eligibleTasks = [], onSubmit }: BlockerModalProps) {
    const [reason, setReason] = useState("");
    const [blockerOwner, setBlockerOwner] = useState("");
    const [followUpAction, setFollowUpAction] = useState<BlockerFollowUpAction | null>(null);
    const [selectedTaskId, setSelectedTaskId] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const needsTaskPicker = !task;
    const resolvedTaskId = task?.id ?? selectedTaskId;
    const hasNoEligibleTasks = needsTaskPicker && eligibleTasks.length === 0;

    function handleOpenChange(newOpen: boolean) {
        if (!newOpen) {
            setReason("");
            setBlockerOwner("");
            setFollowUpAction(null);
            setSelectedTaskId("");
        }

        onOpenChange(newOpen);
    }

    async function handleSubmit() {
        if (!resolvedTaskId || !reason.trim()) {
            return;
        }

        setIsSubmitting(true);

        try {
            await onSubmit({
                taskId: resolvedTaskId,
                reason: reason.trim(),
                blockerOwner: blockerOwner.trim() || undefined,
                followUpAction: followUpAction || undefined,
            });
            handleOpenChange(false);
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
                            <Ban className="h-5 w-5 text-rose-400" />
                        </div>
                        Mark as Blocked
                    </DialogTitle>
                    <DialogDescription>
                        {task ? (
                            <>
                                Record why <span className="font-medium text-foreground">{task.title}</span> is blocked.
                            </>
                        ) : (
                            "Pick a task and record why it's blocked."
                        )}
                    </DialogDescription>
                </DialogHeader>

                {hasNoEligibleTasks ? (
                    <div
                        data-testid="blocker-modal-no-tasks"
                        className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 p-4 text-center"
                    >
                        <ListTodo className="mx-auto mb-3 h-6 w-6 text-rose-400" />
                        <p className="text-sm font-medium text-foreground">No unblocked tasks available</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Every active task is already blocked, or you have no tasks yet. Create or unblock a task
                            first.
                        </p>
                    </div>
                ) : (
                    <div className="mt-4 space-y-4">
                        {needsTaskPicker && (
                            <FormField
                                id="blocker-task"
                                label={
                                    <span className="flex items-center gap-2">
                                        <ListTodo className="h-4 w-4 text-rose-400" />
                                        Which task is blocked?
                                    </span>
                                }
                                required
                            >
                                <Select value={selectedTaskId} onValueChange={setSelectedTaskId}>
                                    <SelectTrigger id="blocker-task" data-testid="blocker-task-select" className="bg-background/50">
                                        <SelectValue placeholder="Select a task" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {eligibleTasks.map((t) => (
                                            <SelectItem key={t.id} value={t.id}>
                                                {t.title}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </FormField>
                        )}

                    <FormField
                        id="blocker-reason"
                        label={
                            <span className="flex items-center gap-2">
                                <AlertTriangle className="h-4 w-4 text-rose-400" />
                                What's blocking this task?
                            </span>
                        }
                        required
                    >
                        <Textarea
                            id="blocker-reason"
                            value={reason}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)}
                            placeholder="e.g., Waiting for API documentation from backend team"
                            className="min-h-[80px] resize-none bg-background/50"
                        />
                    </FormField>

                    <FormField
                        id="blocker-owner"
                        label={
                            <span className="flex items-center gap-2">
                                <User className="h-4 w-4 text-muted-foreground" />
                                Who's responsible for unblocking?
                            </span>
                        }
                        hint="Optional — e.g., @sarah or Backend Team"
                    >
                        <Input
                            id="blocker-owner"
                            value={blockerOwner}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBlockerOwner(e.target.value)}
                            placeholder="e.g., @sarah or Backend Team"
                            className="bg-background/50"
                        />
                    </FormField>

                    <FormField label="What's your next step?" hint="Optional">
                        <div className="grid grid-cols-3 gap-2">
                            {followUpActions.map((action) => (
                                <SelectorButton
                                    key={action.value}
                                    selected={followUpAction === action.value}
                                    onClick={() =>
                                        setFollowUpAction(followUpAction === action.value ? null : action.value)
                                    }
                                    icon={action.icon}
                                    title={action.label}
                                    description={action.description}
                                    layout="column"
                                    selectedClassName={action.selectedClass}
                                />
                            ))}
                        </div>
                    </FormField>
                    </div>
                )}

                <DialogFooter className="mt-6">
                    <Button variant="outline" onClick={() => handleOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        data-testid="blocker-modal-submit"
                        onClick={handleSubmit}
                        disabled={hasNoEligibleTasks || !resolvedTaskId || !reason.trim() || isSubmitting}
                        className="gap-2 bg-rose-600 hover:bg-rose-700"
                    >
                        <Ban className="h-4 w-4" />
                        {isSubmitting ? "Marking..." : "Mark as Blocked"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
