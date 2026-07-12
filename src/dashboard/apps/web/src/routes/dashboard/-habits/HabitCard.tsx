import { Card } from "@ui/components/card";
import { IconButton } from "@ui/components/icon-button";
import { cn } from "@ui/lib/utils";
import { Check, Flame, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import type { HabitWithStats } from "@/lib/habits/habits.server";
import { DeleteHabitDialog } from "./DeleteHabitDialog";
import { HabitHeatmap } from "./HabitHeatmap";
import { getHabitColor, getHabitIcon } from "./habit-catalog";

interface HabitCardProps {
    habit: HabitWithStats;
    pending?: boolean;
    onToggleToday: (habitId: string) => void;
    onArchive: (habitId: string) => void;
    className?: string;
}

export function HabitCard({ habit, pending, onToggleToday, onArchive, className }: HabitCardProps) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const color = getHabitColor(habit.color);
    const Icon = getHabitIcon(habit.icon);

    const weekPct = habit.targetPerWeek > 0 ? Math.min(100, (habit.weekCount / habit.targetPerWeek) * 100) : 0;
    const targetMet = habit.weekCount >= habit.targetPerWeek;

    return (
        <>
            <Card
                variant="plain"
                data-testid="habit-card"
                data-habit-id={habit.id}
                className={cn(
                    "group relative gap-4 overflow-hidden p-5 transition-all duration-200",
                    "hover:-translate-y-0.5",
                    habit.doneToday ? color.border : "border-border",
                    color.glow,
                    className
                )}
            >
                {/* Header: icon + name + meta + delete */}
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        <div
                            className={cn(
                                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-lg",
                                color.accent
                            )}
                        >
                            <Icon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                            <h3 className="truncate text-sm font-semibold text-foreground" data-testid="habit-name">
                                {habit.name}
                            </h3>
                            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                                {habit.cadence === "weekly" ? `${habit.targetPerWeek}× / week` : "daily"}
                            </p>
                        </div>
                    </div>

                    <IconButton
                        variant="ghost"
                        size="icon"
                        tooltip="Archive habit"
                        data-testid="habit-archive-button"
                        className="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-rose-400 group-hover:opacity-100"
                        onClick={() => setConfirmOpen(true)}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                </div>

                {/* Stats row: streak + this week */}
                <div className="flex items-center gap-5">
                    <div className="flex items-center gap-1.5" data-testid="habit-streak">
                        <Flame
                            className={cn(
                                "h-4 w-4",
                                habit.currentStreak > 0 ? "text-orange-400" : "text-muted-foreground/40"
                            )}
                        />
                        <span className="text-lg font-bold tabular-nums text-foreground">{habit.currentStreak}</span>
                        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
                            day{habit.currentStreak === 1 ? "" : "s"}
                        </span>
                    </div>

                    {habit.cadence === "weekly" && (
                        <div className="flex items-center gap-1.5" data-testid="habit-week-progress">
                            <span
                                className={cn(
                                    "text-lg font-bold tabular-nums",
                                    targetMet ? color.text : "text-foreground"
                                )}
                            >
                                {habit.weekCount}
                            </span>
                            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
                                / {habit.targetPerWeek} this week
                            </span>
                        </div>
                    )}
                </div>

                {/* Weekly target bar */}
                {habit.cadence === "weekly" && (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
                        <div
                            className={cn("h-full rounded-full transition-all duration-500", color.accent)}
                            style={{ width: `${weekPct}%` }}
                        />
                    </div>
                )}

                {/* Heatmap centerpiece */}
                <div className="overflow-x-auto pb-1">
                    <HabitHeatmap
                        days={habit.heatmap}
                        color={color}
                        todayPending={pending}
                        onToggleToday={() => onToggleToday(habit.id)}
                    />
                </div>

                {/* Check today button */}
                <button
                    type="button"
                    disabled={pending}
                    onClick={() => onToggleToday(habit.id)}
                    data-testid="habit-check-button"
                    aria-pressed={habit.doneToday}
                    className={cn(
                        "flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition-all",
                        "disabled:opacity-60",
                        habit.doneToday
                            ? cn(color.accent, "text-white shadow-lg hover:brightness-110")
                            : "border border-border bg-muted/30 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                    )}
                >
                    {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {habit.doneToday ? "Done today" : "Mark today"}
                </button>
            </Card>

            <DeleteHabitDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                habitName={habit.name}
                onConfirm={() => {
                    onArchive(habit.id);
                    setConfirmOpen(false);
                }}
            />
        </>
    );
}
