import type { TimesheetWeek } from "@app/clarity/lib/timesheet-weeks";
import type { ClarityTask } from "@app/clarity/lib/types";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Calendar, Loader2, Plus, Search, XCircle } from "lucide-react";
import { useState } from "react";
import { useAppContext } from "../context/AppContext";
import { WorkItemSelector } from "./WorkItemSelector";

interface AddMappingFormProps {
    onMappingAdded: () => void;
}

function formatWeekLabel(start: string, finish: string): string {
    const s = new Date(start);
    const f = new Date(finish);
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `${fmt(s)} – ${fmt(f)}`;
}

function isCurrentWeek(start: string, finish: string): boolean {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    return today >= start && today <= finish;
}

async function fetchWeeks(month?: number, year?: number): Promise<{ weeks: TimesheetWeek[] }> {
    const res = await fetch("/api/clarity-weeks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ month, year }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to load timesheet weeks (${res.status})`);
    }

    return res.json();
}

async function fetchClarityTasks(timesheetId: number): Promise<{ tasks: ClarityTask[] }> {
    const res = await fetch("/api/clarity-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ timesheetId }),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load tasks");
    }

    return res.json();
}

export function AddMappingForm({ onMappingAdded }: AddMappingFormProps) {
    const { month, year } = useAppContext();

    const [selectedWeek, setSelectedWeek] = useState<TimesheetWeek | null>(null);
    const [manualTimesheetId, setManualTimesheetId] = useState("");
    const [useManualId, setUseManualId] = useState(false);
    const [selectedTask, setSelectedTask] = useState<ClarityTask | null>(null);

    const {
        data: weeksData,
        isLoading: weeksLoading,
        error: weeksError,
    } = useQuery({
        queryKey: ["clarity-weeks", month, year],
        queryFn: () => fetchWeeks(month, year),
    });

    const timesheetId = useManualId ? parseInt(manualTimesheetId, 10) : selectedWeek?.timesheetId;

    const tasksMutation = useMutation({
        mutationFn: () => fetchClarityTasks(timesheetId!),
    });

    const canLoadTasks = useManualId
        ? manualTimesheetId.trim() && !Number.isNaN(parseInt(manualTimesheetId, 10))
        : !!selectedWeek;

    return (
        <Card className="border-primary/20">
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                    <Plus className="w-4 h-4" />
                    Add Mapping
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Step 1: Select timesheet week */}
                <div>
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="block text-xs font-mono text-gray-500">Step 1: Select timesheet week</span>
                        <button
                            type="button"
                            onClick={() => {
                                setUseManualId(!useManualId);
                                setSelectedWeek(null);
                                setSelectedTask(null);
                                tasksMutation.reset();
                            }}
                            className="text-[10px] font-mono text-gray-600 hover:text-primary transition-colors"
                        >
                            {useManualId ? "← Show weeks" : "Enter ID manually →"}
                        </button>
                    </div>

                    {useManualId ? (
                        <div className="flex gap-2">
                            <Input
                                type="text"
                                placeholder="Timesheet ID (e.g. 8524081)"
                                value={manualTimesheetId}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                    setManualTimesheetId(e.target.value)
                                }
                                className="flex-1 bg-black/30 border-white/10 font-mono text-sm text-gray-300 placeholder:text-gray-600 focus:border-primary/40"
                            />
                            <Button
                                onClick={() => {
                                    setSelectedTask(null);
                                    tasksMutation.mutate();
                                }}
                                disabled={!canLoadTasks || tasksMutation.isPending}
                                className="bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30 font-mono text-xs"
                            >
                                {tasksMutation.isPending ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Search className="w-3.5 h-3.5" />
                                )}
                                Load
                            </Button>
                        </div>
                    ) : weeksLoading ? (
                        <div className="flex items-center gap-2 text-gray-500 font-mono text-xs py-3">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Loading timesheet weeks...
                        </div>
                    ) : weeksError ? (
                        <div className="flex items-center gap-2 text-red-400 font-mono text-xs py-2">
                            <XCircle className="w-3.5 h-3.5 shrink-0" />
                            {weeksError instanceof Error && weeksError.message.includes("non-JSON") ? (
                                <span>
                                    Clarity session expired.{" "}
                                    <a href="/settings" className="underline text-primary hover:text-primary">
                                        Re-authenticate in Settings
                                    </a>
                                </span>
                            ) : weeksError instanceof Error ? (
                                weeksError.message
                            ) : (
                                "Failed to load weeks"
                            )}
                        </div>
                    ) : (
                        <div className="space-y-1.5">
                            {weeksData?.weeks.map((week) => {
                                const current = isCurrentWeek(week.startDate, week.finishDate);
                                const selected = selectedWeek?.timesheetId === week.timesheetId;

                                return (
                                    <button
                                        key={week.timesheetId}
                                        type="button"
                                        onClick={() => {
                                            setSelectedWeek(week);
                                            setSelectedTask(null);
                                            tasksMutation.reset();
                                        }}
                                        className={`w-full text-left px-3 py-2 rounded border transition-colors font-mono text-xs ${
                                            selected
                                                ? "border-primary/50 bg-primary/10 text-primary"
                                                : current
                                                  ? "border-primary/20 bg-primary/5 text-gray-300"
                                                  : "border-white/5 bg-black/20 text-gray-400 hover:border-primary/20 hover:bg-primary/5"
                                        }`}
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="flex items-center gap-2">
                                                <Calendar className="w-3 h-3" />
                                                {formatWeekLabel(week.startDate, week.finishDate)}
                                                {current && (
                                                    <Badge
                                                        variant="outline"
                                                        className="text-[9px] border-green-500/30 text-green-400"
                                                    >
                                                        This week
                                                    </Badge>
                                                )}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-gray-500">
                                                    {(week.totalHours ?? 0).toFixed(1)}h
                                                </span>
                                                {week.entryCount !== undefined && (
                                                    <span className="text-gray-600 text-[10px]">
                                                        {week.entryCount} task{week.entryCount !== 1 ? "s" : ""}
                                                    </span>
                                                )}
                                                <Badge variant="outline" className="text-[9px]">
                                                    {week.status}
                                                </Badge>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Load tasks button for week selection mode */}
                    {!useManualId && selectedWeek && (
                        <Button
                            onClick={() => {
                                setSelectedTask(null);
                                tasksMutation.mutate();
                            }}
                            disabled={tasksMutation.isPending}
                            className="mt-2 bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30 font-mono text-xs"
                        >
                            {tasksMutation.isPending ? (
                                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                            ) : (
                                <Search className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            Load tasks from {formatWeekLabel(selectedWeek.startDate, selectedWeek.finishDate)}
                        </Button>
                    )}

                    {tasksMutation.error && (
                        <div className="mt-2 flex items-center gap-2 text-red-400 font-mono text-xs">
                            <XCircle className="w-3.5 h-3.5" />
                            {tasksMutation.error.message}
                        </div>
                    )}
                </div>

                {/* Step 2: Select Clarity task */}
                {tasksMutation.data && (
                    <div>
                        <span className="block text-xs font-mono text-gray-500 mb-1.5">
                            Step 2: Select Clarity task
                        </span>
                        <div className="space-y-1.5">
                            {tasksMutation.data.tasks.map((task) => (
                                <button
                                    key={task.taskId}
                                    type="button"
                                    onClick={() => setSelectedTask(task)}
                                    className={`w-full text-left px-3 py-2 rounded border transition-colors font-mono text-xs ${
                                        selectedTask?.taskId === task.taskId
                                            ? "border-primary/50 bg-primary/10 text-primary"
                                            : "border-white/5 bg-black/20 text-gray-400 hover:border-primary/20 hover:bg-primary/5"
                                    }`}
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="font-medium">{task.taskName}</span>
                                        <Badge variant="outline" className="text-[10px]">
                                            {task.taskCode}
                                        </Badge>
                                    </div>
                                    <div className="text-gray-500 mt-0.5">{task.investmentName}</div>
                                </button>
                            ))}

                            {tasksMutation.data.tasks.length === 0 && (
                                <div className="text-gray-500 font-mono text-xs text-center py-4">
                                    No tasks found in this timesheet
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Step 3: Select ADO work items */}
                {selectedTask && (
                    <div>
                        <span className="block text-xs font-mono text-gray-500 mb-1.5">
                            Step 3: Select ADO work items
                        </span>
                        <WorkItemSelector
                            clarityTask={selectedTask}
                            timesheetId={timesheetId}
                            month={month}
                            year={year}
                            onItemsAdded={onMappingAdded}
                        />
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
