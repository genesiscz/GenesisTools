import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { Plus } from "lucide-react";
import { useState } from "react";

interface KeyResultFormProps {
    onAdd: (input: { title: string; unit: string; startValue: number; targetValue: number }) => void;
}

export function KeyResultForm({ onAdd }: KeyResultFormProps) {
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [unit, setUnit] = useState("");
    const [startValue, setStartValue] = useState("0");
    const [targetValue, setTargetValue] = useState("100");

    function reset() {
        setTitle("");
        setUnit("");
        setStartValue("0");
        setTargetValue("100");
    }

    function submit() {
        const trimmed = title.trim();
        if (!trimmed) {
            return;
        }

        const start = Number(startValue) || 0;
        const target = Number(targetValue) || 0;
        onAdd({ title: trimmed, unit: unit.trim(), startValue: start, targetValue: target });
        reset();
        setOpen(false);
    }

    if (!open) {
        return (
            <button
                type="button"
                data-testid="add-key-result-button"
                onClick={() => setOpen(true)}
                className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/60 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/20 hover:text-foreground"
                )}
            >
                <Plus className="h-3.5 w-3.5" />
                Add key result
            </button>
        );
    }

    return (
        <div
            data-testid="key-result-form"
            className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-3"
        >
            <Input
                data-testid="key-result-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Key result (e.g. Sign up 500 users)"
                className="h-8 text-sm"
                autoFocus
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        submit();
                    }
                }}
            />
            <div className="grid grid-cols-3 gap-2">
                <Input
                    value={startValue}
                    onChange={(e) => setStartValue(e.target.value)}
                    type="number"
                    placeholder="Start"
                    aria-label="Start value"
                    className="h-8 text-center font-mono text-xs"
                />
                <Input
                    data-testid="key-result-target-input"
                    value={targetValue}
                    onChange={(e) => setTargetValue(e.target.value)}
                    type="number"
                    placeholder="Target"
                    aria-label="Target value"
                    className="h-8 text-center font-mono text-xs"
                />
                <Input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    placeholder="Unit"
                    aria-label="Unit"
                    className="h-8 text-center text-xs"
                />
            </div>
            <div className="flex justify-end gap-2">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-muted-foreground"
                    onClick={() => {
                        reset();
                        setOpen(false);
                    }}
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="brand"
                    className="h-7"
                    data-testid="key-result-save-button"
                    onClick={submit}
                    disabled={!title.trim()}
                >
                    Add
                </Button>
            </div>
        </div>
    );
}
