import { Input } from "@ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { FormDialog, FormField } from "@ui/custom";
import { useState } from "react";
import type { CreateGoalInput } from "@/lib/goals/goals.server";
import { CATEGORY_OPTIONS, currentQuarter, quarterOptions } from "@/lib/goals/meta";

interface GoalFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: CreateGoalInput) => Promise<void>;
    defaultQuarter?: string;
}

export function GoalForm({ open, onOpenChange, onSubmit, defaultQuarter }: GoalFormProps) {
    const initialQuarter = defaultQuarter ?? currentQuarter();
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [category, setCategory] = useState<string>(CATEGORY_OPTIONS[0].value);
    const [quarter, setQuarter] = useState(initialQuarter);
    const [targetDate, setTargetDate] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [titleError, setTitleError] = useState<string | null>(null);

    const quarters = quarterOptions(initialQuarter);

    function reset() {
        setTitle("");
        setDescription("");
        setCategory(CATEGORY_OPTIONS[0].value);
        setQuarter(initialQuarter);
        setTargetDate("");
        setTitleError(null);
    }

    function handleOpenChange(value: boolean) {
        if (!value) {
            reset();
        }

        onOpenChange(value);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const trimmed = title.trim();
        if (!trimmed) {
            setTitleError("Title is required");
            return;
        }

        setSubmitting(true);
        try {
            await onSubmit({
                title: trimmed,
                description: description.trim(),
                category,
                quarter,
                targetDate: targetDate || null,
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
            title="New Goal"
            description="Set an objective for the quarter and track it with key results."
            onSubmit={handleSubmit}
            submitLabel="Create Goal"
            isSubmitting={submitting}
            submitDisabled={submitting}
        >
            <div className="space-y-4">
                <FormField id="goal-title" label="Title" required error={titleError}>
                    <Input
                        id="goal-title"
                        data-testid="goal-title-input"
                        value={title}
                        onChange={(e) => {
                            setTitle(e.target.value);
                            setTitleError(null);
                        }}
                        placeholder="Ship the v2 launch"
                        autoFocus
                    />
                </FormField>

                <FormField id="goal-description" label="Description">
                    <Textarea
                        id="goal-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Why this matters and what success looks like…"
                        rows={2}
                        className="resize-none"
                    />
                </FormField>

                <div className="grid grid-cols-2 gap-4">
                    <FormField label="Category">
                        <Select value={category} onValueChange={setCategory}>
                            <SelectTrigger data-testid="goal-category-select">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {CATEGORY_OPTIONS.map((opt) => (
                                    <SelectItem key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </FormField>

                    <FormField label="Quarter">
                        <Select value={quarter} onValueChange={setQuarter}>
                            <SelectTrigger data-testid="goal-quarter-select">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {quarters.map((q) => (
                                    <SelectItem key={q} value={q}>
                                        {q}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </FormField>
                </div>

                <FormField id="goal-target-date" label="Target date" hint="Optional deadline for this goal.">
                    <Input
                        id="goal-target-date"
                        type="date"
                        value={targetDate}
                        onChange={(e) => setTargetDate(e.target.value)}
                    />
                </FormField>
            </div>
        </FormDialog>
    );
}
