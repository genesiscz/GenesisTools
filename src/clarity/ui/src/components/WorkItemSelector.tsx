import type { WorkItemTypeColor } from "@app/azure-devops/lib/work-item-enrichment";
import type { AdoWorkItem, TimelogWorkItem } from "@app/clarity/lib/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { CheckCircle, Loader2, Plus, Search, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { TypeBadge } from "./WorkItemLink";

interface ClarityTaskTarget {
    taskId: number;
    taskName: string;
    taskCode: string;
    investmentName: string;
    investmentCode: string;
}

interface WorkItemSelectorProps {
    clarityTask: ClarityTaskTarget;
    timesheetId?: number;
    month: number;
    year: number;
    onItemsAdded: () => void;
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

async function fetchTypeColors(): Promise<{ types: Record<string, WorkItemTypeColor> }> {
    const res = await fetch("/api/workitem-type-colors");

    if (!res.ok) {
        throw new Error("Failed to load type colors");
    }

    return res.json();
}

async function fetchMappings(): Promise<{ mappings: Array<{ adoWorkItemId: number }> }> {
    const res = await fetch("/api/mappings");

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to load mappings (${res.status})`);
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

export function WorkItemSelector({ clarityTask, timesheetId, month, year, onItemsAdded }: WorkItemSelectorProps) {
    const [selectedWorkItems, setSelectedWorkItems] = useState<Map<number, AdoWorkItem>>(new Map());
    const [timelogFilter, setTimelogFilter] = useState("");
    const [showMapped, setShowMapped] = useState(false);
    const [adoQuery, setAdoQuery] = useState("");
    const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);

    const {
        data: timelogData,
        isLoading: timelogLoading,
        error: timelogError,
    } = useQuery({
        queryKey: ["timelog-entries", month, year],
        queryFn: () => fetchTimelogEntries(month, year),
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

        let items = timelogData.workItems;

        if (!showMapped) {
            items = items.filter((wi) => !mappedIds.has(wi.id));
        }

        if (timelogFilter.trim()) {
            const q = timelogFilter.toLowerCase();
            items = items.filter((wi) => `#${wi.id}`.includes(q) || wi.title.toLowerCase().includes(q));
        }

        return items;
    }, [timelogData, timelogFilter, showMapped, mappedIds]);

    const addMutation = useMutation({
        mutationFn: async () => {
            const items = [...selectedWorkItems.values()];
            setSubmitProgress({ done: 0, total: items.length });
            const errors: string[] = [];

            for (let i = 0; i < items.length; i++) {
                const wi = items[i];

                try {
                    await addMappingApi({
                        clarityTaskId: clarityTask.taskId,
                        clarityTaskName: clarityTask.taskName,
                        clarityTaskCode: clarityTask.taskCode,
                        clarityInvestmentName: clarityTask.investmentName,
                        clarityInvestmentCode: clarityTask.investmentCode,
                        clarityTimesheetId: timesheetId,
                        adoWorkItemId: wi.id,
                        adoWorkItemTitle: wi.title,
                        adoWorkItemType: wi.type,
                    });
                } catch (err) {
                    errors.push(`#${wi.id}: ${err instanceof Error ? err.message : "Unknown error"}`);
                }

                setSubmitProgress({ done: i + 1, total: items.length });
            }

            if (errors.length > 0) {
                throw new Error(`Failed to add ${errors.length} mapping(s): ${errors.join("; ")}`);
            }
        },
        onSettled: () => {
            setSelectedWorkItems(new Map());
            setAdoQuery("");
            setTimelogFilter("");
            setSubmitProgress(null);
            adoSearchMutation.reset();
            onItemsAdded();
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

    const canSearchAdo = adoQuery.trim().length >= 2;
    const canAdd = selectedWorkItems.size > 0;

    return (
        <div className="space-y-3">
            {/* Timelog entries section */}
            <div>
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] font-mono text-gray-500">
                        Timelog entries ({month}/{year})
                    </span>
                    <div className="flex items-center gap-3">
                        {mappedIds.size > 0 && (
                            <label className="flex items-center gap-1.5 cursor-pointer text-[10px] font-mono text-gray-500 hover:text-gray-400 transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showMapped}
                                    onChange={(e) => setShowMapped(e.target.checked)}
                                    className="accent-amber-500 w-3 h-3"
                                />
                                Show mapped
                            </label>
                        )}
                        {timelogData?.workItems && (
                            <span className="text-[10px] font-mono text-gray-600">
                                {filteredTimelog.length}/{timelogData.workItems.length} items
                            </span>
                        )}
                    </div>
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
                            const typeColor = typeColors[wi.type];

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
                                    {wi.type && <TypeBadge typeName={wi.type} color={typeColor} />}
                                    <span className="text-gray-500 tabular-nums">{hours}h</span>
                                    <span className="text-gray-600 tabular-nums">
                                        {wi.entryCount} {wi.entryCount === 1 ? "entry" : "entries"}
                                    </span>
                                    {isMapped && (
                                        <Badge
                                            variant="outline"
                                            className="text-[9px] border-green-500/30 text-green-500"
                                        >
                                            Mapped
                                        </Badge>
                                    )}
                                </label>
                            );
                        })}

                        {filteredTimelog.length === 0 && timelogData?.workItems && (
                            <div className="text-gray-500 font-mono text-xs text-center py-3">
                                {timelogFilter ? "No items match filter" : "No timelog entries for this month"}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ADO search section */}
            <div>
                <span className="text-[10px] font-mono text-gray-500 block mb-1.5">Search other ADO item</span>
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
                        Search
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
                            const typeColor = typeColors[wi.type];

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
                                    {wi.type && <TypeBadge typeName={wi.type} color={typeColor} />}
                                    {isMapped ? (
                                        <Badge
                                            variant="outline"
                                            className="text-[9px] border-green-500/30 text-green-500"
                                        >
                                            Mapped
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
                            <div className="text-gray-500 font-mono text-xs text-center py-3">No work items found</div>
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
                        <span className="text-amber-300">{clarityTask.taskName}</span>
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
                            {submitProgress ? `Adding ${submitProgress.done}/${submitProgress.total}...` : "Adding..."}
                        </>
                    ) : (
                        <>
                            <Plus className="w-3.5 h-3.5 mr-2" />
                            Add {selectedWorkItems.size > 1 ? `${selectedWorkItems.size} ` : ""}mappings
                        </>
                    )}
                </Button>
            </div>

            {addMutation.isSuccess && (
                <div className="flex items-center gap-2 text-green-400 font-mono text-xs">
                    <CheckCircle className="w-3.5 h-3.5" />
                    Mappings added successfully
                </div>
            )}

            {addMutation.error && (
                <div className="flex items-center gap-2 text-red-400 font-mono text-xs">
                    <XCircle className="w-3.5 h-3.5" />
                    {addMutation.error.message}
                </div>
            )}
        </div>
    );
}
