import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib/utils";
import {
    Archive,
    CalendarDays,
    CheckCircle2,
    ChevronDown,
    CircleDashed,
    MoreVertical,
    Target,
    Trash2,
} from "lucide-react";
import { useState } from "react";
import type { GoalKeyResult } from "@/drizzle";
import type { CreateKeyResultInput, GoalRow, GoalStatus, UpdateKeyResultInput } from "@/lib/goals/goals.server";
import { categoryMeta } from "@/lib/goals/meta";
import { deriveProgress } from "@/lib/goals/progress";
import { KeyResultForm } from "./KeyResultForm";
import { KeyResultRow } from "./KeyResultRow";
import { ProgressRing } from "./ProgressRing";

interface GoalCardProps {
    goal: GoalRow;
    onSetStatus: (id: string, status: GoalStatus) => void;
    onDelete: (id: string) => void;
    onAddKeyResult: (input: CreateKeyResultInput) => void;
    onUpdateKeyResult: (id: string, patch: UpdateKeyResultInput["patch"]) => void;
    onDeleteKeyResult: (id: string) => void;
}

const STATUS_ACTIONS: { status: GoalStatus; label: string; icon: typeof CheckCircle2 }[] = [
    { status: "active", label: "Mark active", icon: CircleDashed },
    { status: "done", label: "Mark done", icon: CheckCircle2 },
    { status: "archived", label: "Archive", icon: Archive },
];

export function GoalCard({
    goal,
    onSetStatus,
    onDelete,
    onAddKeyResult,
    onUpdateKeyResult,
    onDeleteKeyResult,
}: GoalCardProps) {
    const [expanded, setExpanded] = useState(false);
    const meta = categoryMeta(goal.category);
    const krs: GoalKeyResult[] = goal.keyResults;
    const progress = deriveProgress(goal.progress, krs);
    const derivedFromKrs = krs.length > 0;

    return (
        <Card
            data-testid="goal-card"
            data-status={goal.status}
            data-quarter={goal.quarter}
            className={cn("flex flex-col gap-4 p-5", goal.status === "archived" && "opacity-70")}
        >
            <div className="flex items-start gap-4">
                <ProgressRing
                    value={progress}
                    colorClassName={meta.colorClassName}
                    data-testid="goal-progress-ring"
                    className="shrink-0"
                />

                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <h3 className="truncate text-base font-semibold leading-tight text-foreground">
                                {goal.title}
                            </h3>
                            {goal.description && (
                                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{goal.description}</p>
                            )}
                        </div>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 shrink-0 text-muted-foreground"
                                    data-testid="goal-menu-trigger"
                                    aria-label="Goal actions"
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuLabel>Status</DropdownMenuLabel>
                                {STATUS_ACTIONS.filter((a) => a.status !== goal.status).map((a) => (
                                    <DropdownMenuItem
                                        key={a.status}
                                        data-testid={`goal-status-${a.status}`}
                                        onSelect={() => onSetStatus(goal.id, a.status)}
                                    >
                                        <a.icon className="h-4 w-4" />
                                        {a.label}
                                    </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    variant="destructive"
                                    data-testid="goal-delete"
                                    onSelect={() => onDelete(goal.id)}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Badge variant="cyber" className={cn("gap-1", meta.colorClassName, "border-current/30")}>
                            <Target className="h-3 w-3" />
                            {meta.label}
                        </Badge>
                        {goal.quarter && (
                            <Badge variant="outline" className="gap-1 font-mono text-[11px]">
                                {goal.quarter}
                            </Badge>
                        )}
                        {goal.targetDate && (
                            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                                <CalendarDays className="h-3 w-3" />
                                {goal.targetDate}
                            </span>
                        )}
                        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                            {derivedFromKrs ? `${krs.length} KR${krs.length === 1 ? "" : "s"}` : "manual"}
                        </span>
                    </div>
                </div>
            </div>

            <button
                type="button"
                data-testid="goal-expand"
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center justify-center gap-1.5 rounded-md border border-border/50 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                {expanded ? "Hide key results" : krs.length > 0 ? `Key results (${krs.length})` : "Add key results"}
            </button>

            {expanded && (
                <div data-testid="goal-key-results" className="flex flex-col gap-2.5">
                    {krs.map((kr) => (
                        <KeyResultRow
                            key={kr.id}
                            kr={kr}
                            colorClassName={meta.colorClassName}
                            onUpdateCurrent={(id, value) => onUpdateKeyResult(id, { currentValue: value })}
                            onDelete={onDeleteKeyResult}
                        />
                    ))}
                    <KeyResultForm onAdd={(input) => onAddKeyResult({ ...input, goalId: goal.id })} />
                </div>
            )}
        </Card>
    );
}
