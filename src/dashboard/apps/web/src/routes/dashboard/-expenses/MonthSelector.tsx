import { Button } from "@ui/components/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { currentMonthKey, formatMonthLabel, shiftMonth } from "@/lib/expenses/money";

interface MonthSelectorProps {
    monthKey: string;
    onChange: (monthKey: string) => void;
}

export function MonthSelector({ monthKey, onChange }: MonthSelectorProps) {
    const isCurrent = monthKey === currentMonthKey();

    return (
        <div
            data-testid="month-selector"
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/60 p-1 backdrop-blur-sm"
        >
            <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Previous month"
                data-testid="month-prev"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => onChange(shiftMonth(monthKey, -1))}
            >
                <ChevronLeft className="h-4 w-4" />
            </Button>

            <span
                data-testid="month-label"
                className="min-w-[9.5rem] select-none text-center text-sm font-semibold text-foreground tabular-nums"
            >
                {formatMonthLabel(monthKey)}
            </span>

            <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Next month"
                data-testid="month-next"
                disabled={isCurrent}
                className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-30"
                onClick={() => onChange(shiftMonth(monthKey, 1))}
            >
                <ChevronRight className="h-4 w-4" />
            </Button>
        </div>
    );
}
