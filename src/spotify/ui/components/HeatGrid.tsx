/**
 * The two heat grids: the 7x24 weekly clock, and a year as one cell per day.
 *
 * Both use the same six-step ramp as the terminal renderer, so a screenshot of one and a
 * paste of the other never disagree about what a dark cell means.
 */
import { MONTHS, WEEKDAYS } from "@app/spotify/ui/lib/labels";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
import { cn } from "@ui/lib/utils";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

function heatClass(value: number, max: number): string {
    if (max <= 0 || value <= 0) {
        return "heat-0";
    }

    const step = Math.min(5, 1 + Math.floor((value / max) * 4.999));

    return `heat-${step}`;
}

export function ClockGrid({ grid, byWeekday }: { grid: number[][]; byWeekday: number[] }) {
    const max = Math.max(...grid.flat(), 0);

    return (
        <div className="overflow-x-auto">
            <div className="inline-block min-w-full" role="group" aria-label="Plays by weekday and hour">
                <div className="flex gap-1 pl-10 mb-1">
                    {Array.from({ length: 24 }, (_, h) => (
                        <div key={h} className="w-5 text-center text-[10px] font-mono text-muted-foreground">
                            {String(h).padStart(2, "0")}
                        </div>
                    ))}
                </div>
                {grid.map((row, d) => (
                    <div key={WEEKDAYS[d]} className="flex items-center gap-1 mb-1">
                        <div className="w-9 text-[10px] font-mono text-muted-foreground">{WEEKDAYS[d]}</div>
                        {row.map((v, h) => {
                            const label = `${WEEKDAYS[d]} ${String(h).padStart(2, "0")}:00 · ${v.toLocaleString("en-US")} plays`;

                            // Focusable, so the count is reachable by keyboard rather than by
                            // hover alone: 168 cells is a tolerable number of tab stops for the
                            // one grid where every cell carries a distinct value.
                            return (
                                <Tooltip key={`${WEEKDAYS[d]}-${h}`}>
                                    <TooltipTrigger asChild>
                                        <div
                                            role="img"
                                            aria-label={label}
                                            tabIndex={0}
                                            className={cn(
                                                "w-5 h-5 rounded-[3px] border border-border/30",
                                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                heatClass(v, max)
                                            )}
                                        />
                                    </TooltipTrigger>
                                    <TooltipContent>{label}</TooltipContent>
                                </Tooltip>
                            );
                        })}
                        <div className="pl-2 text-[10px] font-mono text-muted-foreground tabular-nums">
                            {(byWeekday[d] ?? 0).toLocaleString("en-US")}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function YearGrid({ year, days, max }: { year: string; days: Record<string, number>; max: number }) {
    const start = Date.UTC(Number(year), 0, 1);
    const end = Date.UTC(Number(year) + 1, 0, 1);
    const offset = (new Date(start).getUTCDay() + 6) % 7;
    const weeks = Math.ceil((offset + (end - start) / 86400000) / 7);
    const lastDay = Math.round((end - start) / 86400000) - 1;

    // The cell that carries the grid's single tab stop. Arrow keys move it by a day (left and
    // right) or by a week (up and down), which is what the cells are laid out in.
    const [cursor, setCursor] = useState(0);
    const cursorRef = useRef<HTMLDivElement>(null);
    const moved = useRef(false);

    // Only when a key moved the cursor: focusing on first render would scroll the page to the
    // grid, and focusing after a mouse-driven `onFocus` would fight the user.
    useEffect(() => {
        if (moved.current) {
            cursorRef.current?.focus();
            moved.current = false;
        }
    }, [cursor]);

    const move = (to: number) => {
        moved.current = true;
        setCursor(Math.max(0, Math.min(lastDay, to)));
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const step =
            e.key === "ArrowRight"
                ? 7
                : e.key === "ArrowLeft"
                  ? -7
                  : e.key === "ArrowDown"
                    ? 1
                    : e.key === "ArrowUp"
                      ? -1
                      : 0;

        if (step === 0 && e.key !== "Home" && e.key !== "End") {
            return;
        }

        e.preventDefault();
        move(e.key === "Home" ? 0 : e.key === "End" ? lastDay : cursor + step);
    };

    const monthLabel = new Array<string>(weeks).fill("");
    for (let m = 0; m < 12; m++) {
        const col = Math.floor((offset + (Date.UTC(Number(year), m, 1) - start) / 86400000) / 7);
        if (col < weeks) {
            monthLabel[col] = MONTHS[m]!;
        }
    }

    let total = 0;
    let active = 0;
    const byMonth = new Array<number>(12).fill(0);
    for (let i = 0; i < weeks * 7; i++) {
        const dayIndex = i - offset;
        const t = start + dayIndex * 86400000;
        if (dayIndex < 0 || t >= end) {
            continue;
        }

        const v = days[new Date(t).toISOString().slice(0, 10)] ?? 0;
        total += v;
        byMonth[new Date(t).getUTCMonth()] += v;
        if (v) {
            active++;
        }
    }

    return (
        <div className="mb-6" role="group" aria-label={`Plays per day in ${year}`}>
            <div className="flex items-baseline gap-3 mb-2">
                <div className="text-sm font-semibold text-foreground">{year}</div>
                <div className="text-xs text-muted-foreground font-mono">
                    {total.toLocaleString("en-US")} plays on {active} days
                </div>
            </div>
            <p className="sr-only">
                {year} by month: {byMonth.map((v, m) => `${MONTHS[m]} ${v.toLocaleString("en-US")} plays`).join(", ")}.
            </p>
            <div className="overflow-x-auto">
                <div
                    className="inline-flex flex-col gap-1"
                    role="grid"
                    aria-label={`Every day of ${year}`}
                    onKeyDown={onKeyDown}
                >
                    <div className="flex gap-[3px] pl-8">
                        {monthLabel.map((label, w) => (
                            <div key={w} className="w-[11px] text-[9px] font-mono text-muted-foreground">
                                {label ? label.slice(0, 1) : ""}
                            </div>
                        ))}
                    </div>
                    {Array.from({ length: 7 }, (_, wd) => (
                        <div key={WEEKDAYS[wd]} className="flex items-center gap-[3px]" role="row">
                            <div className="w-8 text-[9px] font-mono text-muted-foreground">
                                {wd % 2 === 0 ? WEEKDAYS[wd] : ""}
                            </div>
                            {Array.from({ length: weeks }, (_, w) => {
                                const dayIndex = w * 7 + wd - offset;
                                const t = start + dayIndex * 86400000;
                                if (dayIndex < 0 || t >= end) {
                                    return <div key={w} className="w-[11px] h-[11px]" />;
                                }

                                const iso = new Date(t).toISOString().slice(0, 10);
                                const v = days[iso] ?? 0;
                                const label = `${iso} · ${v.toLocaleString("en-US")} plays`;
                                const isCursor = dayIndex === cursor;

                                // One tab stop for the whole grid, arrow keys inside it: the
                                // roving-tabindex pattern. Per-cell tab stops would be 365 of
                                // them per year, several years to a page.
                                return (
                                    // Uncontrolled on purpose. Forcing `open={false}` on every
                                    // non-cursor cell was how the keyboard cursor got its
                                    // tooltip, and it silently killed hover for the other 364
                                    // days of the year. Radix opens on focus by itself, so the
                                    // keyboard path needs no prop and the mouse path works.
                                    <Tooltip key={iso}>
                                        <TooltipTrigger asChild>
                                            <div
                                                role="gridcell"
                                                aria-label={label}
                                                tabIndex={isCursor ? 0 : -1}
                                                ref={isCursor ? cursorRef : undefined}
                                                onFocus={() => setCursor(dayIndex)}
                                                className={cn(
                                                    "w-[11px] h-[11px] rounded-[2px] border border-border/30",
                                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                    heatClass(v, max)
                                                )}
                                            />
                                        </TooltipTrigger>
                                        <TooltipContent>{label}</TooltipContent>
                                    </Tooltip>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
