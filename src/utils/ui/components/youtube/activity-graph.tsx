import type { UsageDay } from "@app/youtube/lib/types";
import { useState } from "react";
import { formatDiamonds } from "./diamond";

function shortDate(iso: string): string {
    const date = new Date(`${iso}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
        return iso;
    }

    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Interactive daily-spend graph (spec §7: the previously static activity graph
 * made interactive). Each bar is a real `<button>` so it's keyboard-focusable
 * and Enter/Space-activatable for free; hover/focus surfaces the day's value in
 * a live readout, and clicking a bar drills the surrounding list down to that
 * day (`onSelectDate`), clicking it again clears. Shared so the extension panel
 * and web account page use one graph.
 */
export function ActivityGraph({
    days,
    selectedDate,
    onSelectDate,
    loading,
}: {
    days: UsageDay[];
    selectedDate?: string | null;
    onSelectDate?: (date: string | null) => void;
    loading?: boolean;
}) {
    const [hovered, setHovered] = useState<UsageDay | null>(null);
    const maxSpent = Math.max(1, ...days.map((day) => day.spent));
    const active = hovered ?? (selectedDate ? (days.find((day) => day.date === selectedDate) ?? null) : null);

    if (loading) {
        return (
            <div className="space-y-2">
                <GraphLabel />
                <div className="h-16 animate-pulse rounded-lg bg-white/5" />
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <div className="flex items-baseline justify-between">
                <GraphLabel />
                <p className="font-mono text-[12px] tabular-nums text-muted-foreground" aria-live="polite">
                    {active ? (
                        <>
                            <span className="text-foreground">{formatDiamonds(active.spent)} 💎</span>{" "}
                            {shortDate(active.date)}
                        </>
                    ) : selectedDate ? (
                        <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => onSelectDate?.(null)}
                        >
                            clear filter
                        </button>
                    ) : (
                        "hover a day"
                    )}
                </p>
            </div>
            <div className="flex h-16 items-end gap-[2px]">
                {days.map((day) => {
                    const isSelected = day.date === selectedDate;
                    const height = day.spent === 0 ? 6 : Math.max(12, (day.spent / maxSpent) * 100);
                    const tone = isSelected
                        ? "bg-primary"
                        : day.spent === 0
                          ? "bg-white/5 hover:bg-white/10"
                          : "bg-primary/40 hover:bg-primary/70";

                    return (
                        <button
                            key={day.date}
                            type="button"
                            aria-label={`${shortDate(day.date)}: ${day.spent} diamonds spent, ${day.earned} earned`}
                            aria-pressed={onSelectDate ? isSelected : undefined}
                            title={`${shortDate(day.date)} · ${day.spent} 💎 spent`}
                            onMouseEnter={() => setHovered(day)}
                            onMouseLeave={() => setHovered(null)}
                            onFocus={() => setHovered(day)}
                            onBlur={() => setHovered(null)}
                            onClick={() => onSelectDate?.(isSelected ? null : day.date)}
                            disabled={!onSelectDate}
                            className={`min-w-0 flex-1 rounded-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/60 ${tone} ${
                                onSelectDate ? "cursor-pointer" : "cursor-default"
                            }`}
                            style={{ height: `${height}%` }}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function GraphLabel() {
    return (
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            activity · last 30 days
        </p>
    );
}
