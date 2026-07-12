import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib/utils";
import { Minus, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { GoalKeyResult } from "@/drizzle";
import { keyResultFraction } from "@/lib/goals/progress";

interface KeyResultRowProps {
    kr: GoalKeyResult;
    colorClassName: string;
    onUpdateCurrent: (id: string, value: number) => void;
    onDelete: (id: string) => void;
}

export function KeyResultRow({ kr, colorClassName, onUpdateCurrent, onDelete }: KeyResultRowProps) {
    const [draft, setDraft] = useState(String(kr.currentValue));

    useEffect(() => {
        setDraft(String(kr.currentValue));
    }, [kr.currentValue]);

    const pct = Math.round(keyResultFraction(kr) * 100);
    const unitSuffix = kr.unit ? ` ${kr.unit}` : "";

    function commit(next: number) {
        const clamped = Number.isNaN(next) ? kr.currentValue : Math.max(0, next);
        setDraft(String(clamped));
        if (clamped !== kr.currentValue) {
            onUpdateCurrent(kr.id, clamped);
        }
    }

    const step = Math.max(1, Math.round((kr.targetValue - kr.startValue) / 10) || 1);

    return (
        <div data-testid="key-result-row" className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{kr.title}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {kr.currentValue}
                        {unitSuffix} / {kr.targetValue}
                        {unitSuffix}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onDelete(kr.id)}
                    aria-label="Delete key result"
                    className="shrink-0 rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            </div>

            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border/50">
                <div
                    className={cn(
                        "h-full rounded-full transition-[width] duration-500 ease-out",
                        "bg-current",
                        colorClassName
                    )}
                    style={{ width: `${pct}%` }}
                />
            </div>

            <div className="mt-2.5 flex items-center gap-1.5">
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Decrease"
                    onClick={() => commit(kr.currentValue - step)}
                >
                    <Minus className="h-3.5 w-3.5" />
                </Button>
                <Input
                    data-testid="key-result-current-input"
                    type="number"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commit(Number(draft))}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="h-7 w-20 text-center font-mono text-xs"
                />
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Increase"
                    onClick={() => commit(kr.currentValue + step)}
                >
                    <Plus className="h-3.5 w-3.5" />
                </Button>
                <span className={cn("ml-auto font-mono text-xs font-semibold tabular-nums", colorClassName)}>
                    {pct}%
                </span>
            </div>
        </div>
    );
}
