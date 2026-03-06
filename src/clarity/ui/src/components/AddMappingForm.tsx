import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Calendar, CheckCircle, Loader2, Plus, Search, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";

interface ClarityTask {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
    timeEntryId: number;
}

interface TimesheetWeek {
    timesheetId: number;
    timePeriodId: number;
    startDate: string;
    finishDate: string;
    totalHours: number;
    status: string;
}

interface AdoWorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
}

interface TimelogWorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
    totalMinutes: number;
    entryCount: number;
}

interface TypeColorInfo {
    color: string;
    name: string;
    icon: { id: string; url: string };
}

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
        body: JSON.stringify({ month, year }),
    });

    if (!res.ok) {
        throw new Error("Failed to load timesheet weeks");
    }

    return res.json();
}

async function fetchClarityTasks(timesheetId: number): Promise<{ tasks: ClarityTask[] }> {
    const res = await fetch("/api/clarity-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timesheetId }),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load tasks");
    }

    return res.json();
}

async function fetchTimelogEntries(month: number, year: number): Promise<{ workItems: TimelogWorkItem[] }> {
    const res = await fetch("/api/timelog-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year }),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to load timelog entries");
    }

    return res.json();
}

async function fetchTypeColors(): Promise<{ types: Record<string, TypeColorInfo> }> {
    const res = await fetch("/api/workitem-type-colors");

    if (!res.ok) {
        throw new Error("Failed to load type colors");
    }

    return res.json();
}

async function fetchMappings(): Promise<{ mappings: Array<{ adoWorkItemId: number }> }> {
    const res = await fetch("/api/mappings");

    if (!res.ok) {
        return { mappings: [] };
    }

    return res.json();
}

async function searchAdoWorkItems(query: string): Promise<{ items: AdoWorkItem[] }> {
    const res = await fetch("/api/ado-workitems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to search work items");
    }

    return res.json();
}

async function addMappingApi(data: Record<string, unknown>) {
    const res = await fetch("/api/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add mapping");
    }

    return res.json();
}

function TypeBadge({ typeName, colors }: { typeName: string; colors: Record<string, TypeColorInfo> }) {
    const info = colors[typeName];

    if (!info) {
        return (
            <Badge variant="outline" className="text-[10px]">
                {typeName}
            </Badge>
        );
    }

    const color = info.color;

    return (
        <span
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{
                borderLeft: `3px solid #${color}`,
                backgroundColor: `#${color}18`,
                color: `#${color}`,
            }}
        >
            {typeName}
        </span>
    );
}

export function AddMappingForm({ onMappingAdded }: AddMappingFormProps) {
    const { month, year } = useAppContext();

    const [selectedWeek, setSelectedWeek] = useState<TimesheetWeek | null>(null);
    const [manualTimesheetId, setManualTimesheetId] = useState("");
    const [useManualId, setUseManualId] = useState(false);
    const [selectedTask, setSelectedTask] = useState<ClarityTask | null>(null);

    // Step 3 state
    const [selectedWorkItems, setSelectedWorkItems] = useState<Map<number, AdoWorkItem>>(new Map());
    const [timelogFilter, setTimelogFilter] = useState("");
    const [adoQuery, setAdoQuery] = useState("");
    const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);

    const {
        data: weeksData,
        isLoading: weeksLoading,
        error: weeksError,
    } = useQuery({
        queryKey: ["clarity-weeks"],
        queryFn: fetchWeeks,
    });

    const timesheetId = useManualId ? parseInt(manualTimesheetId, 10) : selectedWeek?.timesheetId;

    const tasksMutation = useMutation({
        mutationFn: () => fetchClarityTasks(timesheetId!),
    });

    const {
        data: timelogData,
        isLoading: timelogLoading,
        error: timelogError,
    } = useQuery({
        queryKey: ["timelog-entries", month, year],
        queryFn: () => fetchTimelogEntries(month, year),
        enabled: !!selectedTask,
    });

    const { data: typeColorsData } = useQuery({
        queryKey: ["workitem-type-colors"],
        queryFn: fetchTypeColors,
        staleTime: 60 * 60 * 1000,
    });

    const { data: mappingsData } = useQuery({
        queryKey: ["mappings"],
        queryFn: fetchMappings,
    });

    const adoSearchMutation = useMutation({
        mutationFn: () => searchAdoWorkItems(adoQuery),
    });

    const mappedIds = useMemo(() => {
        const ids = new Set<number>();

        if (mappingsData?.mappings) {
            for (const m of mappingsData.mappings) {
                ids.add(m.adoWorkItemId);
            }
        }

        return ids;
    }, [mappingsData]);

    const typeColors = typeColorsData?.types ?? {};

    const filteredTimelog = useMemo(() => {
        if (!timelogData?.workItems) {
            return [];
        }

        if (!timelogFilter.trim()) {
            return timelogData.workItems;
        }

        const q = timelogFilter.toLowerCase();

        return timelogData.workItems.filter(
            (wi) => `#${wi.id}`.includes(q) || wi.title.toLowerCase().includes(q)
        );
    }, [timelogData, timelogFilter]);

    const addMutation = useMutation({
        mutationFn: async () => {
            const items = [...selectedWorkItems.values()];
            setSubmitProgress({ done: 0, total: items.length });

            for (let i = 0; i < items.length; i++) {
                const wi = items[i];

                await addMappingApi({
                    clarityTaskId: selectedTask!.taskId,
                    clarityTaskName: selectedTask!.taskName,
                    clarityTaskCode: selectedTask!.taskCode,
                    clarityInvestmentName: selectedTask!.investmentName,
                    clarityInvestmentCode: selectedTask!.investmentCode,
                    clarityTimesheetId: timesheetId,
                    adoWorkItemId: wi.id,
                    adoWorkItemTitle: wi.title,
                    adoWorkItemType: wi.type,
                });

                setSubmitProgress({ done: i + 1, total: items.length });
            }
        },
        onSuccess: () => {
            setSelectedWorkItems(new Map());
            setAdoQuery("");
            setTimelogFilter("");
            setSubmitProgress(null);
            adoSearchMutation.reset();
            onMappingAdded();
        },
        onError: () => {
            setSubmitProgress(null);
        },
    });

    const toggleTimelogItem = (wi: TimelogWorkItem) => {
        if (mappedIds.has(wi.id)) {
            return;
        }

        setSelectedWorkItems((prev) => {
            const next = new Map(prev);

            if (next.has(wi.id)) {
                next.delete(wi.id);
            } else {
                next.set(wi.id, { id: wi.id, title: wi.title, type: wi.type, state: wi.state });
            }

            return next;
        });
    };

    const addSearchItem = (wi: AdoWorkItem) => {
        if (mappedIds.has(wi.id)) {
            return;
        }

        setSelectedWorkItems((prev) => {
            const next = new Map(prev);
            next.set(wi.id, wi);
            return next;
        });
    };

    const removeSelectedItem = (id: number) => {
        setSelectedWorkItems((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
    };

    const canLoadTasks = useManualId
        ? manualTimesheetId.trim() && !Number.isNaN(parseInt(manualTimesheetId, 10))
        : !!selectedWeek;
    const canSearchAdo = adoQuery.trim().length >= 2;
    const canAdd = selectedTask && selectedWorkItems.size > 0;

    return (
        <Card className="border-amber-500/20">
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                    <Plus className="w-4 h-4" />
                    ADD MAPPING
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Step 1: Select timesheet week */}
                <div>
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="block text-xs font-mono text-gray-500">STEP 1: SELECT TIMESHEET WEEK</span>
                        <button
                            type="button"
                            onClick={() => {
                                setUseManualId(!useManualId);
                                setSelectedWeek(null);
                                setSelectedTask(null);
                                tasksMutation.reset();
                            }}
                            className="text-[10px] font-mono text-gray-600 hover:text-amber-400 transition-colors"
                        >
                            {useManualId ? "← SHOW WEEKS" : "ENTER ID MANUALLY →"}
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
                                className="flex-1 bg-black/30 border-white/10 font-mono text-sm text-gray-300 placeholder:text-gray-600 focus:border-amber-500/40"
                            />
                            <Button
                                onClick={() => {
                                    setSelectedTask(null);
                                    tasksMutation.mutate();
                                }}
                                disabled={!canLoadTasks || tasksMutation.isPending}
                                className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                            >
                                {tasksMutation.isPending ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Search className="w-3.5 h-3.5" />
                                )}
                                LOAD
                            </Button>
                        </div>
                    ) : weeksLoading ? (
                        <div className="flex items-center gap-2 text-gray-500 font-mono text-xs py-3">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Loading timesheet weeks...
                        </div>
                    ) : weeksError ? (
                        <div className="flex items-center gap-2 text-red-400 font-mono text-xs py-2">
                            <XCircle className="w-3.5 h-3.5" />
                            {weeksError instanceof Error ? weeksError.message : "Failed to load weeks"}
                        </div>
                    ) : (
                        <div className="space-y-1.5 max-h-52 overflow-y-auto">
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
                                                ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                                                : current
                                                  ? "border-amber-500/20 bg-amber-500/5 text-gray-300"
                                                  : "border-white/5 bg-black/20 text-gray-400 hover:border-amber-500/20 hover:bg-amber-500/5"
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
                                                        THIS WEEK
                                                    </Badge>
                                                )}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span className="text-gray-500">{week.totalHours.toFixed(1)}h</span>
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
                            className="mt-2 bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                        >
                            {tasksMutation.isPending ? (
                                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                            ) : (
                                <Search className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            LOAD TASKS FROM {formatWeekLabel(selectedWeek.startDate, selectedWeek.finishDate)}
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
                            STEP 2: SELECT CLARITY TASK
                        </span>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                            {tasksMutation.data.tasks.map((task) => (
                                <button
                                    key={task.taskId}
                                    type="button"
                                    onClick={() => {
                                        setSelectedTask(task);
                                        setSelectedWorkItems(new Map());
                                        setTimelogFilter("");
                                    }}
                                    className={`w-full text-left px-3 py-2 rounded border transition-colors font-mono text-xs ${
                                        selectedTask?.taskId === task.taskId
                                            ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                                            : "border-white/5 bg-black/20 text-gray-400 hover:border-amber-500/20 hover:bg-amber-500/5"
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

                {/* Step 3: Select ADO work items (multi-select) */}
                {selectedTask && (
                    <div className="space-y-3">
                        <span className="block text-xs font-mono text-gray-500">
                            STEP 3: SELECT ADO WORK ITEMS
                        </span>

                        {/* Timelog entries section */}
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[10px] font-mono text-gray-500 uppercase">
                                    Timelog entries ({month}/{year})
                                </span>
                                {timelogData?.workItems && (
                                    <span className="text-[10px] font-mono text-gray-600">
                                        {timelogData.workItems.length} items
                                    </span>
                                )}
                            </div>

                            <Input
                                type="text"
                                placeholder="Filter by #id or title..."
                                value={timelogFilter}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTimelogFilter(e.target.value)}
                                className="mb-1.5 bg-black/30 border-white/10 font-mono text-sm text-gray-300 placeholder:text-gray-600 focus:border-cyan-500/40"
                            />

                            {timelogLoading ? (
                                <div className="flex items-center gap-2 text-gray-500 font-mono text-xs py-3">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Loading timelog entries...
                                </div>
                            ) : timelogError ? (
                                <div className="flex items-center gap-2 text-red-400 font-mono text-xs py-2">
                                    <XCircle className="w-3.5 h-3.5" />
                                    {timelogError instanceof Error ? timelogError.message : "Failed to load"}
                                </div>
                            ) : (
                                <div className="space-y-1 max-h-56 overflow-y-auto">
                                    {filteredTimelog.map((wi) => {
                                        const isMapped = mappedIds.has(wi.id);
                                        const isSelected = selectedWorkItems.has(wi.id);
                                        const hours = (wi.totalMinutes / 60).toFixed(1);

                                        return (
                                            <label
                                                key={wi.id}
                                                className={`flex items-center gap-2.5 w-full px-3 py-2 rounded border transition-colors font-mono text-xs ${
                                                    isMapped
                                                        ? "border-white/5 bg-black/10 text-gray-600 cursor-not-allowed"
                                                        : isSelected
                                                          ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300 cursor-pointer"
                                                          : "border-white/5 bg-black/20 text-gray-400 hover:border-cyan-500/20 hover:bg-cyan-500/5 cursor-pointer"
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    disabled={isMapped}
                                                    onChange={() => toggleTimelogItem(wi)}
                                                    className="accent-cyan-500 w-3.5 h-3.5"
                                                />
                                                <span className="text-amber-400/80">#{wi.id}</span>
                                                <span className="flex-1 truncate font-medium">{wi.title}</span>
                                                {wi.type && <TypeBadge typeName={wi.type} colors={typeColors} />}
                                                <span className="text-gray-500 tabular-nums">{hours}h</span>
                                                <span className="text-gray-600 tabular-nums">
                                                    {wi.entryCount} {wi.entryCount === 1 ? "entry" : "entries"}
                                                </span>
                                                {isMapped && (
                                                    <Badge
                                                        variant="outline"
                                                        className="text-[9px] border-green-500/30 text-green-500"
                                                    >
                                                        MAPPED
                                                    </Badge>
                                                )}
                                            </label>
                                        );
                                    })}

                                    {filteredTimelog.length === 0 && timelogData?.workItems && (
                                        <div className="text-gray-500 font-mono text-xs text-center py-3">
                                            {timelogFilter
                                                ? "No items match filter"
                                                : "No timelog entries for this month"}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* ADO search section */}
                        <div>
                            <span className="text-[10px] font-mono text-gray-500 uppercase block mb-1.5">
                                Search other ADO item
                            </span>
                            <div className="flex gap-2">
                                <Input
                                    type="text"
                                    placeholder="Search by title or enter Work Item ID..."
                                    value={adoQuery}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAdoQuery(e.target.value)}
                                    onKeyDown={(e: React.KeyboardEvent) => {
                                        if (e.key === "Enter" && canSearchAdo) {
                                            adoSearchMutation.mutate();
                                        }
                                    }}
                                    className="flex-1 bg-black/30 border-white/10 font-mono text-sm text-gray-300 placeholder:text-gray-600 focus:border-cyan-500/40"
                                />
                                <Button
                                    onClick={() => adoSearchMutation.mutate()}
                                    disabled={!canSearchAdo || adoSearchMutation.isPending}
                                    className="bg-cyan-500/20 border border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/30 font-mono text-xs"
                                >
                                    {adoSearchMutation.isPending ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                        <Search className="w-3.5 h-3.5" />
                                    )}
                                    SEARCH
                                </Button>
                            </div>

                            {adoSearchMutation.error && (
                                <div className="mt-1.5 flex items-center gap-2 text-red-400 font-mono text-xs">
                                    <XCircle className="w-3.5 h-3.5" />
                                    {adoSearchMutation.error.message}
                                </div>
                            )}

                            {adoSearchMutation.data && (
                                <div className="space-y-1 mt-1.5 max-h-40 overflow-y-auto">
                                    {adoSearchMutation.data.items.map((wi) => {
                                        const isMapped = mappedIds.has(wi.id);
                                        const isSelected = selectedWorkItems.has(wi.id);

                                        return (
                                            <div
                                                key={wi.id}
                                                className={`flex items-center gap-2.5 w-full px-3 py-2 rounded border font-mono text-xs ${
                                                    isMapped
                                                        ? "border-white/5 bg-black/10 text-gray-600"
                                                        : isSelected
                                                          ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300"
                                                          : "border-white/5 bg-black/20 text-gray-400"
                                                }`}
                                            >
                                                <span className="text-amber-400/80">#{wi.id}</span>
                                                <span className="flex-1 truncate font-medium">{wi.title}</span>
                                                {wi.type && <TypeBadge typeName={wi.type} colors={typeColors} />}
                                                {isMapped ? (
                                                    <Badge
                                                        variant="outline"
                                                        className="text-[9px] border-green-500/30 text-green-500"
                                                    >
                                                        MAPPED
                                                    </Badge>
                                                ) : isSelected ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => removeSelectedItem(wi.id)}
                                                        className="text-red-400/60 hover:text-red-400 transition-colors"
                                                    >
                                                        <XCircle className="w-3.5 h-3.5" />
                                                    </button>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() => addSearchItem(wi)}
                                                        className="text-cyan-400/60 hover:text-cyan-400 transition-colors"
                                                    >
                                                        <Plus className="w-3.5 h-3.5" />
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}

                                    {adoSearchMutation.data.items.length === 0 && (
                                        <div className="text-gray-500 font-mono text-xs text-center py-3">
                                            No work items found
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Selected summary + Add button */}
                        <div className="pt-2 border-t border-white/5">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-mono text-gray-500">
                                    Selected: <span className="text-cyan-400">{selectedWorkItems.size} items</span>
                                    {" → "}
                                    <span className="text-amber-300">{selectedTask.taskName}</span>
                                </span>
                            </div>

                            <Button
                                onClick={() => addMutation.mutate()}
                                disabled={!canAdd || addMutation.isPending}
                                className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs"
                            >
                                {addMutation.isPending ? (
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                                        {submitProgress
                                            ? `ADDING ${submitProgress.done}/${submitProgress.total}...`
                                            : "ADDING..."}
                                    </>
                                ) : (
                                    <>
                                        <Plus className="w-3.5 h-3.5 mr-2" />
                                        ADD {selectedWorkItems.size > 1 ? `${selectedWorkItems.size} ` : ""}MAPPINGS
                                    </>
                                )}
                            </Button>
                        </div>

                        {addMutation.isSuccess && (
                            <div className="flex items-center gap-2 text-green-400 font-mono text-xs">
                                <CheckCircle className="w-3.5 h-3.5" />
                                {selectedWorkItems.size === 0 ? "Mappings added successfully" : "Done"}
                            </div>
                        )}

                        {addMutation.error && (
                            <div className="flex items-center gap-2 text-red-400 font-mono text-xs">
                                <XCircle className="w-3.5 h-3.5" />
                                {addMutation.error.message}
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
