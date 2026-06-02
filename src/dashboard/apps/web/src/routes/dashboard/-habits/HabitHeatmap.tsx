import { cn } from "@ui/lib/utils";
import type { HabitHeatmapDay } from "@/lib/habits/habits.server";
import { todayKey } from "@/lib/habits/habits-dates";
import { countToLevel, type HabitColor } from "./habit-catalog";

interface HabitHeatmapProps {
    days: HabitHeatmapDay[];
    color: HabitColor;
    todayPending?: boolean;
    onToggleToday: () => void;
}

const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

/**
 * GitHub-style contribution grid. `days` is oldest-first and contiguous
 * (count 0 for empty days). We pad the head so the first column starts on a
 * Monday, then lay columns left→right (weeks) with 7 rows (Mon..Sun).
 */
export function HabitHeatmap({ days, color, todayPending, onToggleToday }: HabitHeatmapProps) {
    const today = todayKey();

    // Pad the head so the grid starts on a Monday (dow index 0 = Monday).
    const firstDow = days.length > 0 ? localDow(days[0].day) : 0;
    const padCount = firstDow;
    const cells: (HabitHeatmapDay | null)[] = [...Array.from({ length: padCount }, () => null), ...days];

    const weeks: (HabitHeatmapDay | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
        weeks.push(cells.slice(i, i + 7));
    }

    const monthLabels = buildMonthLabels(weeks);

    return (
        <div className="flex flex-col gap-1.5" data-testid="habit-heatmap">
            {/* Month labels above the grid */}
            <div className="flex gap-[3px] pl-7 text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">
                {monthLabels.map((label, i) => (
                    <span
                        key={`${label}-${i}`}
                        className="w-[11px] shrink-0 overflow-visible whitespace-nowrap"
                        aria-hidden
                    >
                        {label}
                    </span>
                ))}
            </div>

            <div className="flex gap-[3px]">
                {/* Weekday rail */}
                <div className="flex w-6 shrink-0 flex-col gap-[3px] pr-1 text-[8px] font-mono uppercase text-muted-foreground/45">
                    {WEEKDAY_LABELS.map((label, i) => (
                        <span key={i} className="flex h-[11px] items-center justify-end leading-none">
                            {label}
                        </span>
                    ))}
                </div>

                {/* Week columns */}
                <div className="flex gap-[3px]">
                    {weeks.map((week, wi) => (
                        <div key={wi} className="flex flex-col gap-[3px]">
                            {Array.from({ length: 7 }, (_, di) => {
                                const cell = week[di] ?? null;
                                if (!cell) {
                                    return <span key={di} className="h-[11px] w-[11px]" aria-hidden />;
                                }

                                const level = countToLevel(cell.count);
                                const isToday = cell.day === today;
                                const fill =
                                    level === 0
                                        ? "bg-muted/40"
                                        : color.heatmapLevels[Math.min(level, 4) - 1];

                                if (isToday) {
                                    return (
                                        <button
                                            key={di}
                                            type="button"
                                            disabled={todayPending}
                                            onClick={onToggleToday}
                                            title={`${cell.day}${cell.count > 0 ? " — done" : ""} (toggle)`}
                                            data-testid="habit-heatmap-today"
                                            className={cn(
                                                "h-[11px] w-[11px] rounded-[2px] ring-1 ring-foreground/50 transition-transform",
                                                "hover:scale-125 disabled:opacity-60",
                                                fill
                                            )}
                                        />
                                    );
                                }

                                return (
                                    <span
                                        key={di}
                                        title={`${cell.day}${cell.count > 0 ? " — done" : ""}`}
                                        className={cn("h-[11px] w-[11px] rounded-[2px]", fill)}
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-1.5 pl-7 pt-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground/45">
                <span>less</span>
                <span className="h-[10px] w-[10px] rounded-[2px] bg-muted/40" />
                {color.heatmapLevels.map((c, i) => (
                    <span key={i} className={cn("h-[10px] w-[10px] rounded-[2px]", c)} />
                ))}
                <span>more</span>
            </div>
        </div>
    );
}

/** Local day-of-week with Monday=0 .. Sunday=6, parsed from a YYYY-MM-DD key. */
function localDow(dayKey: string): number {
    const [y, m, d] = dayKey.split("-").map(Number);
    const date = new Date(y, m - 1, d, 12, 0, 0, 0);
    return (date.getDay() + 6) % 7;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One label per week column — month name when a new month starts, else blank. */
function buildMonthLabels(weeks: (HabitHeatmapDay | null)[][]): string[] {
    let lastMonth = -1;
    return weeks.map((week) => {
        const firstReal = week.find((c) => c !== null);
        if (!firstReal) {
            return "";
        }

        const month = Number(firstReal.day.split("-")[1]) - 1;
        if (month !== lastMonth) {
            lastMonth = month;
            return MONTH_NAMES[month];
        }
        return "";
    });
}
