import { buildWeekComment } from "@app/clarity/lib/comment-builder";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { AlertTriangle, Bug, CheckCircle, ChevronRight, Play, SkipForward, XCircle } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { CommentPopup } from "../components/CommentPopup";
import { FillWeekCard } from "../components/FillWeekCard";
import { MonthPicker } from "../components/MonthPicker";
import { PostFillReviewDialog } from "../components/PostFillReviewDialog";
import { useAppContext } from "../context/AppContext";

interface FillEntryResult {
    clarityTaskName: string;
    clarityTaskCode: string;
    timesheetId: number;
    timeEntryId: number;
    totalHours: number;
    segments: Array<{ date: string; hours: number }>;
    status: "success" | "error" | "skipped";
    error?: string;
    debug?: {
        url: string;
        method: string;
        requestBody: unknown;
        responseStatus: number;
        responseBody: unknown;
    };
}

interface ExecuteFillResult {
    success: number;
    failed: number;
    skipped: number;
    entries: FillEntryResult[];
}

async function fetchFillPreview(month: number, year: number) {
    const res = await fetch("/api/fill/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ month, year }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Preview failed (${res.status})`);
    }

    return res.json();
}

interface PreviewWeekTimelogEntry {
    workItemId: number;
    workItemTitle: string;
    workItemType: string;
    timeTypeDescription: string;
    comment: string | null;
    date: string;
    minutes: number;
}

interface PreviewWeek {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    hasNotes?: boolean;
    numberOfNotes?: number;
    entries: Array<{
        clarityTaskName: string;
        clarityTaskCode: string;
        dayValues: Record<string, number>;
        totalMinutes: number;
        timelogEntries?: PreviewWeekTimelogEntry[];
    }>;
    unmappedWorkItems: Array<{ workItemId: number; minutes: number }>;
}

async function executeFillApi(month: number, year: number, weekIds: number[]): Promise<ExecuteFillResult> {
    const res = await fetch("/api/fill/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: SafeJSON.stringify({ month, year, weekIds }),
    });

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Fill failed (${res.status})`);
    }

    return res.json();
}

export const Route = createFileRoute("/import")({
    component: ImportPage,
});

function ImportPage() {
    const { month, year, setMonthYear } = useAppContext();
    const [selectedWeeks, setSelectedWeeks] = useState<Set<number>>(new Set());
    const [showConfirm, setShowConfirm] = useState(false);
    const [alsoPostComments, setAlsoPostComments] = useState(false);
    const [commentedWeekIds, setCommentedWeekIds] = useState<number[]>([]);
    const [showReviewDialog, setShowReviewDialog] = useState(false);

    const {
        data: preview,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["fill-preview", month, year],
        queryFn: () => fetchFillPreview(month, year),
    });

    const selectedWeekNotes = useMemo(() => {
        if (!preview?.weeks) {
            return [];
        }

        return preview.weeks
            .filter((w: PreviewWeek) => selectedWeeks.has(w.timesheetId))
            .map((w: PreviewWeek) => ({
                timesheetId: w.timesheetId,
                periodStart: w.periodStart,
                periodFinish: w.periodFinish,
                hasNotes: w.hasNotes,
                numberOfNotes: w.numberOfNotes,
                timelogEntries: w.entries.flatMap((e) => e.timelogEntries ?? []),
            }));
    }, [preview, selectedWeeks]);

    const fillMutation = useMutation({
        mutationFn: () => executeFillApi(month, year, [...selectedWeeks]),
        onSuccess: async () => {
            const commented: number[] = [];

            if (alsoPostComments && preview?.userId) {
                for (const week of selectedWeekNotes) {
                    const text = buildWeekComment(week.timelogEntries);

                    if (text.trim()) {
                        try {
                            const res = await fetch("/api/post-note", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: SafeJSON.stringify({
                                    timesheetId: week.timesheetId,
                                    noteText: text,
                                    userId: preview.userId,
                                }),
                            });

                            if (res.ok) {
                                commented.push(week.timesheetId);
                            }
                        } catch {
                            // Non-fatal — fill succeeded, comment failed
                        }
                    }
                }
            }

            setCommentedWeekIds(commented);
            setShowConfirm(false);
            setSelectedWeeks(new Set());
            setAlsoPostComments(false);
            setShowReviewDialog(true);
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
                    Clarity <span className="text-primary">Import</span>
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
                            Mapped: {(preview.totalMapped / 60).toFixed(1)}h
                        </Badge>

                        {preview.totalUnmapped > 0 && (
                            <Badge variant="outline" className="font-mono text-xs border-red-500/30 text-red-400">
                                Unmapped: {(preview.totalUnmapped / 60).toFixed(1)}h
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
                        <Card className="border-primary/20">
                            <CardContent className="p-8 text-center">
                                <div className="text-gray-500 font-mono text-sm">
                                    {preview.diagnostics?.message ??
                                        "No week data available. Check that mappings have cached timesheet IDs."}
                                </div>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="space-y-4">
                            {preview.weeks.map((week: PreviewWeek) => (
                                <FillWeekCard
                                    key={week.timesheetId}
                                    {...week}
                                    selected={selectedWeeks.has(week.timesheetId)}
                                    onToggle={() => toggleWeek(week.timesheetId)}
                                    adoConfig={preview.adoConfig}
                                />
                            ))}
                        </div>
                    )}

                    {/* Execute button */}
                    {preview.weeks.length > 0 && selectedWeeks.size > 0 && (
                        <div className="mt-8 flex justify-center">
                            {!showConfirm ? (
                                <Button
                                    onClick={() => setShowConfirm(true)}
                                    className="bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30 hover:shadow-[0_0_12px_color-mix(in_oklch,var(--color-primary)_45%,transparent)] font-mono tracking-wider px-8 py-3 text-sm"
                                >
                                    <Play className="w-4 h-4 mr-2" />
                                    Execute Fill ({selectedWeeks.size} week{selectedWeeks.size > 1 ? "s" : ""})
                                </Button>
                            ) : (
                                <Card className="border-primary/40 w-full max-w-md">
                                    <CardHeader>
                                        <CardTitle className="text-sm font-mono text-primary flex items-center gap-2">
                                            <AlertTriangle className="w-4 h-4" />
                                            Confirm Fill
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-sm text-gray-400 font-mono mb-3">
                                            This will update {selectedWeeks.size} Clarity timesheet(s). This action
                                            cannot be easily undone.
                                        </p>
                                        <label className="flex items-center gap-2 text-xs font-mono text-gray-400 mb-3 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={alsoPostComments}
                                                onChange={(e) => setAlsoPostComments(e.target.checked)}
                                                className="accent-primary"
                                            />
                                            Also post weekly comments
                                        </label>
                                        {alsoPostComments && (
                                            <Alert variant="warning" className="mb-3">
                                                <AlertTriangle className="w-4 h-4" />
                                                <AlertDescription className="font-mono text-[10px]">
                                                    Comments are additive — each post creates a new note. Clarity only
                                                    shows the first note per week to PM. Review after posting.
                                                </AlertDescription>
                                            </Alert>
                                        )}
                                        <div className="flex gap-3">
                                            <Button
                                                onClick={() => fillMutation.mutate()}
                                                disabled={fillMutation.isPending}
                                                className="bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30 font-mono text-xs flex-1"
                                            >
                                                {fillMutation.isPending ? "Executing..." : "Confirm"}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() => setShowConfirm(false)}
                                                className="font-mono text-xs"
                                            >
                                                Cancel
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    )}

                    {/* Results */}
                    {fillMutation.data && <FillResultsCard result={fillMutation.data} />}

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

                    {fillMutation.data && (
                        <PostFillReviewDialog
                            open={showReviewDialog}
                            onClose={() => setShowReviewDialog(false)}
                            result={fillMutation.data}
                            commentedWeeks={commentedWeekIds}
                        />
                    )}

                    <CommentPopup weeks={selectedWeekNotes} userId={preview.userId} />
                </>
            )}
        </div>
    );
}

function StatusIcon({ status }: { status: "success" | "error" | "skipped" }) {
    if (status === "success") {
        return <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />;
    }

    if (status === "error") {
        return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
    }

    return <SkipForward className="w-4 h-4 text-gray-500 flex-shrink-0" />;
}

function FillResultsCard({ result }: { result: ExecuteFillResult }) {
    const [showDebug, setShowDebug] = useState(false);
    const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());

    const allSuccess = result.failed === 0 && result.skipped === 0;

    function toggleEntry(idx: number) {
        setExpandedEntries((prev) => {
            const next = new Set(prev);

            if (next.has(idx)) {
                next.delete(idx);
            } else {
                next.add(idx);
            }

            return next;
        });
    }

    return (
        <Card className={`mt-6 ${allSuccess ? "border-green-500/20" : "border-primary/20"}`}>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-mono text-gray-200 flex items-center gap-2">
                        {allSuccess ? (
                            <CheckCircle className="w-5 h-5 text-green-400" />
                        ) : (
                            <AlertTriangle className="w-5 h-5 text-primary" />
                        )}
                        Fill Results
                    </CardTitle>
                    <div className="flex items-center gap-3">
                        <div className="flex gap-2">
                            {result.success > 0 && (
                                <Badge
                                    variant="outline"
                                    className="font-mono text-xs border-green-500/30 text-green-400"
                                >
                                    {result.success} updated
                                </Badge>
                            )}
                            {result.failed > 0 && (
                                <Badge variant="outline" className="font-mono text-xs border-red-500/30 text-red-400">
                                    {result.failed} failed
                                </Badge>
                            )}
                            {result.skipped > 0 && (
                                <Badge variant="outline" className="font-mono text-xs border-gray-500/30 text-gray-400">
                                    {result.skipped} skipped
                                </Badge>
                            )}
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowDebug(!showDebug)}
                            className={`text-xs font-mono gap-1.5 ${showDebug ? "text-primary" : "text-gray-500"}`}
                        >
                            <Bug className="w-3.5 h-3.5" />
                            Debug
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-1">
                {result.entries.map((entry, idx) => {
                    const isExpanded = expandedEntries.has(idx);
                    const hasDebug = showDebug && entry.debug;
                    const entryKey = `${entry.timesheetId}-${entry.timeEntryId}-${entry.clarityTaskCode}`;

                    return (
                        <Fragment key={entryKey}>
                            <button
                                type="button"
                                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-white/5 w-full text-left ${
                                    isExpanded ? "bg-white/[0.03]" : ""
                                }`}
                                onClick={() => toggleEntry(idx)}
                            >
                                <ChevronRight
                                    className={`w-3.5 h-3.5 text-gray-500 flex-shrink-0 transition-transform ${
                                        isExpanded ? "rotate-90" : ""
                                    }`}
                                />
                                <StatusIcon status={entry.status} />
                                <span className="font-mono text-sm text-gray-300 truncate flex-1">
                                    {entry.clarityTaskName}
                                </span>
                                {entry.totalHours > 0 && (
                                    <span className="font-mono text-xs text-primary flex-shrink-0">
                                        {entry.totalHours.toFixed(1)}h
                                    </span>
                                )}
                                <Badge
                                    variant="outline"
                                    className={`font-mono text-[10px] flex-shrink-0 ${
                                        entry.status === "success"
                                            ? "border-green-500/30 text-green-500"
                                            : entry.status === "error"
                                              ? "border-red-500/30 text-red-400"
                                              : "border-gray-500/30 text-gray-500"
                                    }`}
                                >
                                    {entry.status}
                                </Badge>
                            </button>
                            {isExpanded && (
                                <div className="ml-10 mb-2 space-y-2">
                                    {/* Entry metadata */}
                                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono text-gray-500">
                                        <div>
                                            Timesheet: <span className="text-gray-400">#{entry.timesheetId}</span>
                                        </div>
                                        <div>
                                            TimeEntry: <span className="text-gray-400">#{entry.timeEntryId}</span>
                                        </div>
                                        <div>
                                            Task Code: <span className="text-gray-400">{entry.clarityTaskCode}</span>
                                        </div>
                                        <div>
                                            Total: <span className="text-primary">{entry.totalHours.toFixed(2)}h</span>
                                        </div>
                                    </div>

                                    {/* Day segments */}
                                    {entry.segments.length > 0 && (
                                        <div className="flex gap-2 flex-wrap">
                                            {entry.segments.map((s) => (
                                                <span
                                                    key={s.date}
                                                    className="text-xs font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary"
                                                >
                                                    {s.date.slice(5)} {s.hours.toFixed(1)}h
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {/* Error message */}
                                    {entry.error && (
                                        <div className="text-xs font-mono text-red-400 bg-red-500/5 px-2 py-1 rounded">
                                            {entry.error}
                                        </div>
                                    )}

                                    {/* Debug: HTTP request/response */}
                                    {hasDebug && (
                                        <div className="space-y-2 border border-gray-700/50 rounded p-2 bg-black/30">
                                            <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">
                                                HTTP Request
                                            </div>
                                            <pre className="text-xs font-mono text-gray-400 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                                                <span className="text-primary">
                                                    {entry.debug!.method} {entry.debug!.url}
                                                </span>
                                                {"\n\n"}
                                                {SafeJSON.stringify(entry.debug!.requestBody, null, 2)}
                                            </pre>

                                            <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider mt-2">
                                                HTTP Response ({entry.debug!.responseStatus})
                                            </div>
                                            <pre className="text-xs font-mono text-gray-400 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                                                {SafeJSON.stringify(entry.debug!.responseBody, null, 2)}
                                            </pre>
                                        </div>
                                    )}
                                </div>
                            )}
                        </Fragment>
                    );
                })}
            </CardContent>
        </Card>
    );
}
