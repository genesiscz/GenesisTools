import { Input } from "@ui/components/input";
import { FormDialog, FormField } from "@ui/custom";
import { cn } from "@ui/lib/utils";
import type React from "react";
import { useState } from "react";
import type { CreateHabitInput } from "@/lib/habits/habits.server";
import { HABIT_COLORS, HABIT_ICONS } from "./habit-catalog";

interface HabitFormProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (input: CreateHabitInput) => Promise<void>;
}

const CADENCES: { id: "daily" | "weekly"; label: string }[] = [
    { id: "daily", label: "Daily" },
    { id: "weekly", label: "Weekly" },
];

export function HabitForm({ open, onOpenChange, onSubmit }: HabitFormProps) {
    const [name, setName] = useState("");
    const [color, setColor] = useState(HABIT_COLORS[0].id);
    const [icon, setIcon] = useState(HABIT_ICONS[0].id);
    const [cadence, setCadence] = useState<"daily" | "weekly">("daily");
    const [targetPerWeek, setTargetPerWeek] = useState(3);
    const [submitting, setSubmitting] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);

    function reset() {
        setName("");
        setColor(HABIT_COLORS[0].id);
        setIcon(HABIT_ICONS[0].id);
        setCadence("daily");
        setTargetPerWeek(3);
        setNameError(null);
    }

    function handleOpenChange(value: boolean) {
        if (!value) {
            reset();
        }

        onOpenChange(value);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) {
            setNameError("Give your habit a name");
            return;
        }

        setSubmitting(true);
        try {
            await onSubmit({
                name: trimmed,
                color,
                icon,
                cadence,
                targetPerWeek: cadence === "weekly" ? Math.max(1, Math.min(7, targetPerWeek)) : 7,
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
            title="New habit"
            description="Track a daily or weekly habit and build a streak."
            onSubmit={handleSubmit}
            submitLabel="Create habit"
            isSubmitting={submitting}
            submitDisabled={!name.trim()}
        >
            <div className="space-y-5">
                <FormField label="Name" required error={nameError}>
                    <Input
                        value={name}
                        onChange={(e) => {
                            setName(e.target.value);
                            setNameError(null);
                        }}
                        placeholder="e.g. Morning run, Read 20 pages"
                        data-testid="habit-name-input"
                        autoFocus
                    />
                </FormField>

                {/* Cadence toggle */}
                <FormField label="Cadence">
                    <div className="flex gap-2" data-testid="habit-cadence-toggle">
                        {CADENCES.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => setCadence(c.id)}
                                data-testid={`habit-cadence-${c.id}`}
                                className={cn(
                                    "flex-1 rounded-lg border py-2 text-sm font-medium transition-all",
                                    cadence === c.id
                                        ? "border-primary/50 bg-primary/15 text-foreground"
                                        : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                                )}
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                </FormField>

                {/* Weekly target (only for weekly cadence) */}
                {cadence === "weekly" && (
                    <FormField label="Times per week" hint="How many days a week counts as a win">
                        <div className="flex gap-1.5" data-testid="habit-target-picker">
                            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                                <button
                                    key={n}
                                    type="button"
                                    onClick={() => setTargetPerWeek(n)}
                                    className={cn(
                                        "h-9 flex-1 rounded-lg border text-sm font-semibold tabular-nums transition-all",
                                        targetPerWeek === n
                                            ? "border-primary/50 bg-primary/15 text-foreground"
                                            : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    {n}
                                </button>
                            ))}
                        </div>
                    </FormField>
                )}

                {/* Color picker */}
                <FormField label="Color">
                    <div className="flex flex-wrap gap-2" data-testid="habit-color-picker">
                        {HABIT_COLORS.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                aria-label={c.label}
                                aria-pressed={color === c.id}
                                onClick={() => setColor(c.id)}
                                className={cn(
                                    "h-8 w-8 rounded-full transition-transform hover:scale-110",
                                    c.accent,
                                    color === c.id
                                        ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                                        : "opacity-70 hover:opacity-100"
                                )}
                            />
                        ))}
                    </div>
                </FormField>

                {/* Icon picker */}
                <FormField label="Icon">
                    <div className="flex flex-wrap gap-2" data-testid="habit-icon-picker">
                        {HABIT_ICONS.map(({ id, label, Icon }) => (
                            <button
                                key={id}
                                type="button"
                                aria-label={label}
                                aria-pressed={icon === id}
                                onClick={() => setIcon(id)}
                                className={cn(
                                    "flex h-9 w-9 items-center justify-center rounded-lg border transition-all",
                                    icon === id
                                        ? "border-primary/50 bg-primary/15 text-foreground"
                                        : "border-border bg-muted/30 text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Icon className="h-4 w-4" />
                            </button>
                        ))}
                    </div>
                </FormField>
            </div>
        </FormDialog>
    );
}
