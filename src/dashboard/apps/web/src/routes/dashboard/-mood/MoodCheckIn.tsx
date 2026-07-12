import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import { TagChip } from "@ui/custom";
import { cn } from "@ui/lib/utils";
import { Check, Loader2, Sparkles } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { MoodCheckInValues } from "@/lib/mood/hooks/useMood";
import type { MoodEntryRow } from "@/lib/mood/mood.server";
import { ENERGY_COLOR, ENERGY_LABELS, MOOD_SCALE, MOOD_VALUES, type MoodValue } from "@/lib/mood/mood-scale";

interface MoodCheckInProps {
    today: string;
    todayEntry: MoodEntryRow | null;
    saving: boolean;
    onSave: (values: MoodCheckInValues) => Promise<void>;
}

const FIELD_LABEL = "font-mono text-[10px] tracking-widest uppercase text-muted-foreground/70 mb-2 block";

export function MoodCheckIn({ today, todayEntry, saving, onSave }: MoodCheckInProps) {
    const [mood, setMood] = useState<MoodValue | null>(null);
    const [energy, setEnergy] = useState<MoodValue>(3);
    const [note, setNote] = useState("");
    const [tags, setTags] = useState<string[]>([]);
    const [tagInput, setTagInput] = useState("");
    const [justSaved, setJustSaved] = useState(false);
    const tagInputRef = useRef<HTMLInputElement>(null);

    const isUpdate = todayEntry !== null;

    // Pre-fill from today's entry whenever it loads/changes.
    useEffect(() => {
        if (todayEntry) {
            setMood(todayEntry.mood as MoodValue);
            setEnergy(todayEntry.energy as MoodValue);
            setNote(todayEntry.note);
            setTags(todayEntry.tags);
        }
    }, [todayEntry]);

    const selectedMeta = mood ? MOOD_SCALE[mood] : null;

    function addTag(value: string) {
        const cleaned = value.trim().toLowerCase().replace(/\s+/g, "-");
        if (cleaned && !tags.includes(cleaned)) {
            setTags([...tags, cleaned]);
        }

        setTagInput("");
    }

    function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(tagInput);
        } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
            setTags(tags.slice(0, -1));
        }
    }

    async function handleSave() {
        if (!mood) {
            return;
        }

        await onSave({ mood, energy, note, tags });
        setJustSaved(true);
        window.setTimeout(() => setJustSaved(false), 2200);
    }

    const todayLabel = new Date(`${today}T00:00:00`).toLocaleDateString("default", {
        weekday: "long",
        month: "long",
        day: "numeric",
    });

    return (
        <Card
            variant="wow-static"
            data-testid="mood-checkin"
            className="relative overflow-hidden rounded-2xl p-6 sm:p-8 gap-0"
        >
            {/* Ambient glow tinted by the chosen mood */}
            <div
                className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full blur-3xl opacity-20 transition-colors duration-500"
                style={{ backgroundColor: selectedMeta?.color ?? "var(--primary)" }}
            />

            <div className="relative flex items-center justify-between gap-3 mb-1">
                <h2 className="text-2xl font-bold text-foreground">How are you?</h2>
                {isUpdate && (
                    <span className="font-mono text-[10px] tracking-widest uppercase text-emerald-400/80">
                        Logged today
                    </span>
                )}
            </div>
            <p className="relative text-sm text-muted-foreground mb-6">{todayLabel}</p>

            {/* Mood picker */}
            <div className="relative mb-6">
                <span className={FIELD_LABEL}>Mood</span>
                <div className="flex flex-wrap gap-3">
                    {MOOD_VALUES.map((v) => {
                        const meta = MOOD_SCALE[v];
                        const active = mood === v;
                        return (
                            <button
                                key={v}
                                type="button"
                                data-testid={`mood-pick-${v}`}
                                onClick={() => setMood(v)}
                                aria-pressed={active}
                                aria-label={meta.label}
                                className={cn(
                                    "group flex flex-1 min-w-[64px] flex-col items-center gap-1.5 rounded-xl border px-2 py-3",
                                    "transition-all duration-200 hover:-translate-y-0.5",
                                    active
                                        ? "border-transparent ring-2 scale-[1.03]"
                                        : "border-border bg-background/40 hover:bg-muted/40"
                                )}
                                style={
                                    active
                                        ? {
                                              backgroundColor: `${meta.color}1f`,
                                              boxShadow: `0 0 0 2px ${meta.color}, 0 8px 24px -8px ${meta.color}`,
                                          }
                                        : undefined
                                }
                            >
                                <span className="text-3xl transition-transform duration-200 group-hover:scale-110">
                                    {meta.emoji}
                                </span>
                                <span
                                    className={cn(
                                        "text-[11px] font-medium",
                                        active ? meta.textClass : "text-muted-foreground"
                                    )}
                                >
                                    {meta.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Energy picker */}
            <div className="relative mb-6">
                <span className={FIELD_LABEL}>
                    Energy · <span className="text-foreground/70">{ENERGY_LABELS[energy]}</span>
                </span>
                <div className="flex gap-2">
                    {MOOD_VALUES.map((v) => {
                        const active = energy >= v;
                        return (
                            <button
                                key={v}
                                type="button"
                                data-testid={`energy-pick-${v}`}
                                onClick={() => setEnergy(v)}
                                aria-label={`Energy ${v}`}
                                className={cn(
                                    "h-9 flex-1 rounded-lg border transition-all duration-150",
                                    active ? "border-transparent" : "border-border bg-background/40 hover:bg-muted/40"
                                )}
                                style={active ? { backgroundColor: `${ENERGY_COLOR}cc` } : undefined}
                            />
                        );
                    })}
                </div>
            </div>

            {/* Note */}
            <div className="relative mb-5">
                <span className={FIELD_LABEL}>Note (optional)</span>
                <Textarea
                    data-testid="mood-note-input"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What's on your mind?"
                    rows={2}
                    className="resize-none bg-background/40"
                />
            </div>

            {/* Tags */}
            <div className="relative mb-6">
                <span className={FIELD_LABEL}>Tags (optional)</span>
                <button
                    type="button"
                    onClick={() => tagInputRef.current?.focus()}
                    className="flex w-full cursor-text flex-wrap gap-1.5 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left transition-colors focus-within:border-primary/50"
                >
                    {tags.map((tag) => (
                        <TagChip key={tag} onRemove={() => setTags(tags.filter((t) => t !== tag))}>
                            {tag}
                        </TagChip>
                    ))}
                    <Input
                        ref={tagInputRef}
                        data-testid="mood-tag-input"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={handleTagKeyDown}
                        onBlur={() => tagInput.trim() && addTag(tagInput)}
                        placeholder={tags.length === 0 ? "e.g. work, sleep, exercise" : ""}
                        className="h-7 min-w-[120px] flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                    />
                </button>
            </div>

            {/* Save */}
            <div className="relative flex items-center gap-3">
                <Button
                    type="button"
                    variant="brand"
                    size="lg"
                    data-testid="mood-save-button"
                    onClick={handleSave}
                    disabled={!mood || saving}
                    className="gap-2"
                >
                    {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : justSaved ? (
                        <Check className="h-4 w-4" />
                    ) : (
                        <Sparkles className="h-4 w-4" />
                    )}
                    {justSaved ? "Saved" : isUpdate ? "Update check-in" : "Save check-in"}
                </Button>
                {justSaved && (
                    <span
                        data-testid="mood-saved-confirmation"
                        className="text-sm font-medium text-emerald-400 animate-in fade-in slide-in-from-left-2"
                    >
                        Logged for today
                    </span>
                )}
            </div>
        </Card>
    );
}
