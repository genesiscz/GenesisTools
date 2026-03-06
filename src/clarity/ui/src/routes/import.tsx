import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { AlertTriangle, CheckCircle, Play, XCircle } from "lucide-react";
import { useState } from "react";
import { FillWeekCard } from "../components/FillWeekCard";
import { MonthPicker } from "../components/MonthPicker";
import { useAppContext } from "../context/AppContext";

async function fetchFillPreview(month: number, year: number) {
    const res = await fetch("/api/fill/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Preview failed (${res.status})`);
    }

    return res.json();
}

async function executeFillApi(month: number, year: number, weekIds: number[]) {
    const res = await fetch("/api/fill/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year, weekIds }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Fill failed (${res.status})`);
    }

    return res.json();
}

export function ImportPage() {
    const { month, year, setMonthYear } = useAppContext();
    const [selectedWeeks, setSelectedWeeks] = useState<Set<number>>(new Set());
    const [showConfirm, setShowConfirm] = useState(false);

    const {
        data: preview,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["fill-preview", month, year],
        queryFn: () => fetchFillPreview(month, year),
    });

    const fillMutation = useMutation({
        mutationFn: () => executeFillApi(month, year, [...selectedWeeks]),
        onSuccess: () => {
            setShowConfirm(false);
        },
    });

    const toggleWeek = (timesheetId: number) => {
        setSelectedWeeks((prev) => {
            const next = new Set(prev);

            if (next.has(timesheetId)) {
                next.delete(timesheetId);
            } else {
                next.add(timesheetId);
            }

            return next;
        });
    };

    const selectAll = () => {
        if (preview?.weeks) {
            setSelectedWeeks(new Set(preview.weeks.map((w: { timesheetId: number }) => w.timesheetId)));
        }
    };

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-xl font-mono font-bold text-gray-200">
                    CLARITY <span className="text-amber-500">IMPORT</span>
                </h1>
                <MonthPicker
                    month={month}
                    year={year}
                    onChange={(m, y) => {
                        setMonthYear(m, y);
                        setSelectedWeeks(new Set());
                    }}
                />
            </div>

            {isLoading && (
                <div className="space-y-4">
                    <Skeleton variant="card" />
                    <Skeleton variant="card" />
                </div>
            )}

            {error && (
                <Card className="border-red-500/20">
                    <CardContent className="p-6">
                        <div className="text-red-400 font-mono text-sm flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4" />
                            {error instanceof Error ? error.message : "Failed to load preview"}
                        </div>
                    </CardContent>
                </Card>
            )}

            {preview && (
                <>
                    {/* Summary */}
                    <div className="flex items-center gap-4 mb-6">
                        <Badge variant="outline" className="font-mono text-xs border-green-500/30 text-green-400">
                            MAPPED: {(preview.totalMapped / 60).toFixed(1)}h
                        </Badge>

                        {preview.totalUnmapped > 0 && (
                            <Badge variant="outline" className="font-mono text-xs border-red-500/30 text-red-400">
                                UNMAPPED: {(preview.totalUnmapped / 60).toFixed(1)}h
                            </Badge>
                        )}

                        <div className="flex-1" />

                        {preview.weeks.length > 0 && (
                            <Button variant="ghost" size="sm" onClick={selectAll} className="text-xs font-mono">
                                Select All
                            </Button>
                        )}
                    </div>

                    {/* Week cards */}
                    {preview.weeks.length === 0 ? (
                        <Card className="border-amber-500/20">
                            <CardContent className="p-8 text-center">
                                <div className="text-gray-500 font-mono text-sm">
                                    No week data available. Check that mappings have cached timesheet IDs.
                                </div>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="space-y-4">
                            {preview.weeks.map(
                                (week: {
                                    timesheetId: number;
                                    periodStart: string;
                                    periodFinish: string;
                                    entries: Array<{
                                        clarityTaskName: string;
                                        clarityTaskCode: string;
                                        dayValues: Record<string, number>;
                                        totalMinutes: number;
                                    }>;
                                    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
                                }) => (
                                    <FillWeekCard
                                        key={week.timesheetId}
                                        {...week}
                                        selected={selectedWeeks.has(week.timesheetId)}
                                        onToggle={() => toggleWeek(week.timesheetId)}
                                    />
                                )
                            )}
                        </div>
                    )}

                    {/* Execute button */}
                    {preview.weeks.length > 0 && selectedWeeks.size > 0 && (
                        <div className="mt-8 flex justify-center">
                            {!showConfirm ? (
                                <Button
                                    onClick={() => setShowConfirm(true)}
                                    className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 hover:neon-glow font-mono tracking-wider px-8 py-3 text-sm"
                                >
                                    <Play className="w-4 h-4 mr-2" />
                                    EXECUTE FILL ({selectedWeeks.size} week{selectedWeeks.size > 1 ? "s" : ""})
                                </Button>
                            ) : (
                                <Card className="border-amber-500/40 w-full max-w-md">
                                    <CardHeader>
                                        <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                                            <AlertTriangle className="w-4 h-4" />
                                            CONFIRM FILL
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-sm text-gray-400 font-mono mb-4">
                                            This will update {selectedWeeks.size} Clarity timesheet(s). This action
                                            cannot be easily undone.
                                        </p>
                                        <div className="flex gap-3">
                                            <Button
                                                onClick={() => fillMutation.mutate()}
                                                disabled={fillMutation.isPending}
                                                className="bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 font-mono text-xs flex-1"
                                            >
                                                {fillMutation.isPending ? "EXECUTING..." : "CONFIRM"}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => setShowConfirm(false)}
                                                className="font-mono text-xs"
                                            >
                                                CANCEL
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    )}

                    {/* Results */}
                    {fillMutation.data && (
                        <Card className="mt-6 border-green-500/20">
                            <CardContent className="p-6">
                                <div className="flex items-center gap-2 mb-3">
                                    {fillMutation.data.failed === 0 ? (
                                        <CheckCircle className="w-5 h-5 text-green-400" />
                                    ) : (
                                        <XCircle className="w-5 h-5 text-red-400" />
                                    )}
                                    <span className="font-mono text-sm text-gray-200">
                                        {fillMutation.data.success} updated, {fillMutation.data.failed} failed
                                    </span>
                                </div>

                                {fillMutation.data.errors.length > 0 && (
                                    <div className="space-y-1">
                                        {fillMutation.data.errors.map((err: string) => (
                                            <div key={err} className="text-xs font-mono text-red-400">
                                                {err}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    {fillMutation.error && (
                        <Card className="mt-6 border-red-500/20">
                            <CardContent className="p-6">
                                <div className="text-red-400 font-mono text-sm">
                                    {fillMutation.error instanceof Error
                                        ? fillMutation.error.message
                                        : "Fill execution failed"}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </>
            )}
        </div>
    );
}
