import { getDaysInPeriod, subtractDay } from "@app/utils/date";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { CheckCircle, ChevronRight, XCircle } from "lucide-react";
import { Fragment, useState } from "react";
import type { AdoConfig } from "./WorkItemLink";
import { WorkItemLink } from "./WorkItemLink";

interface TimelogEntry {
    workItemId: number;
    workItemTitle: string;
    workItemType: string;
    timeTypeDescription: string;
    comment: string | null;
    date: string;
    minutes: number;
}

interface WeekEntry {
    clarityTaskName: string;
    clarityTaskCode: string;
    dayValues: Record<string, number>;
    totalMinutes: number;
    timelogEntries?: TimelogEntry[];
    clarityCurrentMinutes?: number;
    clarityDayValues?: Record<string, number>;
    clarityOnly?: boolean;
}

interface UnmappedItem {
    workItemId: number;
    minutes: number;
}

interface FillWeekCardProps {
    timesheetId: number;
    periodStart: string;
    periodFinish: string;
    entries: WeekEntry[];
    unmappedWorkItems: UnmappedItem[];
    clarityTotalMinutes?: number;
    selected: boolean;
    onToggle: () => void;
    adoConfig?: AdoConfig | null;
}

export function FillWeekCard({
    timesheetId,
    periodStart,
    periodFinish,
    entries,
    unmappedWorkItems,
    clarityTotalMinutes,
    selected,
    onToggle,
    adoConfig,
}: FillWeekCardProps) {
    const startDate = periodStart.split("T")[0];
    const endDate = subtractDay(periodFinish.split("T")[0]);
    const workDays = getDaysInPeriod(periodStart, periodFinish);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    function toggleExpand(code: string) {
        setExpanded((prev) => {
            const next = new Set(prev);

            if (next.has(code)) {
                next.delete(code);
            } else {
                next.add(code);
            }

            return next;
        });
    }

    return (
        <Card className={`border-primary/20 ${selected ? "ring-1 ring-primary/40" : ""}`}>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-mono text-gray-300 flex items-center gap-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={selected} onChange={onToggle} className="accent-primary" />
                            Week: {startDate} to {endDate}
                        </label>
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        {clarityTotalMinutes !== undefined && (
                            <span className="font-mono text-[10px] text-gray-500">
                                Clarity: {(clarityTotalMinutes / 60).toFixed(1)}h
                            </span>
                        )}
                        <Badge variant="outline" className="font-mono text-xs">
                            TS#{timesheetId}
                        </Badge>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                {entries.length === 0 ? (
                    <div className="text-gray-500 font-mono text-sm py-4 text-center">
                        No mapped entries for this week
                    </div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow className="border-primary/20">
                                <TableHead className="font-mono text-xs text-gray-400">Clarity Task</TableHead>
                                {workDays.map((d) => {
                                    const dayTotal = entries.reduce((sum, e) => sum + (e.dayValues[d.date] ?? 0), 0);
                                    return (
                                        <TableHead key={d.date} className="font-mono text-xs text-gray-400 text-center">
                                            <div>{d.label}</div>
                                            {dayTotal > 0 && (
                                                <div className="text-primary/60">{(dayTotal / 60).toFixed(1)}h</div>
                                            )}
                                        </TableHead>
                                    );
                                })}
                                <TableHead className="font-mono text-xs text-gray-400 text-right">Total</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {entries
                                .filter((e) => !e.clarityOnly)
                                .map((entry) => {
                                    const isExpanded = expanded.has(entry.clarityTaskCode);
                                    const hasEntries = entry.timelogEntries && entry.timelogEntries.length > 0;

                                    return (
                                        <Fragment key={entry.clarityTaskCode}>
                                            <TableRow
                                                className={`border-white/5 ${hasEntries ? "cursor-pointer hover:bg-primary/5" : ""}`}
                                                onClick={
                                                    hasEntries ? () => toggleExpand(entry.clarityTaskCode) : undefined
                                                }
                                            >
                                                <TableCell className="font-mono text-sm text-gray-300">
                                                    <div className="flex items-center gap-1.5">
                                                        {hasEntries && (
                                                            <ChevronRight
                                                                className={`w-3.5 h-3.5 text-gray-500 flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                                                            />
                                                        )}
                                                        <div className="truncate" title={entry.clarityTaskName}>
                                                            {entry.clarityTaskName}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                {workDays.map((d) => {
                                                    const mins = entry.dayValues[d.date] ?? 0;
                                                    const clarityMins = entry.clarityDayValues?.[d.date];

                                                    return (
                                                        <TableCell
                                                            key={d.date}
                                                            className={`font-mono text-xs text-center ${mins > 0 ? "text-primary" : "text-gray-600"}`}
                                                        >
                                                            <div className="flex flex-col items-center">
                                                                {mins > 0 ? `${(mins / 60).toFixed(1)}h` : "-"}
                                                                <DayClarityIndicator
                                                                    adoMinutes={mins}
                                                                    clarityMinutes={clarityMins}
                                                                />
                                                            </div>
                                                        </TableCell>
                                                    );
                                                })}
                                                <TableCell className="font-mono text-sm text-right font-bold text-gray-200">
                                                    <div className="flex items-center justify-end gap-1.5">
                                                        {(entry.totalMinutes / 60).toFixed(1)}h
                                                        <ClarityStatusIcon
                                                            clarityMinutes={entry.clarityCurrentMinutes}
                                                            adoMinutes={entry.totalMinutes}
                                                        />
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                            {isExpanded && (
                                                <TableRow className="border-white/5">
                                                    <TableCell colSpan={workDays.length + 2} className="p-0">
                                                        <TimelogEntriesTable
                                                            entries={entry.timelogEntries ?? []}
                                                            adoConfig={adoConfig}
                                                        />
                                                    </TableCell>
                                                </TableRow>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            {entries.some((e) => e.clarityOnly) && (
                                <>
                                    <TableRow className="border-primary/10">
                                        <TableCell
                                            colSpan={workDays.length + 2}
                                            className="font-mono text-[10px] text-gray-500 py-1.5 uppercase tracking-wider"
                                        >
                                            Clarity only (no ADO mapping)
                                        </TableCell>
                                    </TableRow>
                                    {entries
                                        .filter((e) => e.clarityOnly)
                                        .map((entry) => (
                                            <TableRow key={entry.clarityTaskCode} className="border-white/5">
                                                <TableCell className="font-mono text-sm text-gray-500">
                                                    <div className="truncate" title={entry.clarityTaskName}>
                                                        {entry.clarityTaskName}
                                                    </div>
                                                </TableCell>
                                                {workDays.map((d) => {
                                                    const clarityMins = entry.clarityDayValues?.[d.date] ?? 0;

                                                    return (
                                                        <TableCell
                                                            key={d.date}
                                                            className={`font-mono text-xs text-center ${clarityMins > 0 ? "text-gray-400" : "text-gray-600"}`}
                                                        >
                                                            {clarityMins > 0
                                                                ? `${(clarityMins / 60).toFixed(1)}h`
                                                                : "-"}
                                                        </TableCell>
                                                    );
                                                })}
                                                <TableCell className="font-mono text-sm text-right text-gray-400">
                                                    {((entry.clarityCurrentMinutes ?? 0) / 60).toFixed(1)}h
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                </>
                            )}
                            {entries.filter((e) => !e.clarityOnly).length > 1 &&
                                (() => {
                                    const adoEntries = entries.filter((e) => !e.clarityOnly);
                                    const weekAdoTotal = adoEntries.reduce((sum, e) => sum + e.totalMinutes, 0);

                                    return (
                                        <TableRow className="border-primary/20">
                                            <TableCell className="font-mono text-xs text-gray-400 font-bold">
                                                Total
                                            </TableCell>
                                            {workDays.map((d) => {
                                                const adoDayTotal = adoEntries.reduce(
                                                    (sum, e) => sum + (e.dayValues[d.date] ?? 0),
                                                    0
                                                );
                                                const clarityOnlyDayTotal = entries
                                                    .filter((e) => e.clarityOnly)
                                                    .reduce((sum, e) => sum + (e.clarityDayValues?.[d.date] ?? 0), 0);
                                                const dayTotal = adoDayTotal + clarityOnlyDayTotal;

                                                return (
                                                    <TableCell
                                                        key={d.date}
                                                        className={`font-mono text-xs text-center font-bold ${dayTotal > 0 ? "text-primary" : "text-gray-600"}`}
                                                    >
                                                        {dayTotal > 0 ? `${(dayTotal / 60).toFixed(1)}h` : "-"}
                                                    </TableCell>
                                                );
                                            })}
                                            <TableCell className="font-mono text-sm text-right font-bold text-primary">
                                                <div className="flex items-center justify-end gap-1.5">
                                                    {(weekAdoTotal / 60).toFixed(1)}h
                                                    {clarityTotalMinutes !== undefined && (
                                                        <span className="text-[10px] text-gray-500 font-normal">
                                                            c:{(clarityTotalMinutes / 60).toFixed(1)}h
                                                        </span>
                                                    )}
                                                    <ClarityStatusIcon
                                                        clarityMinutes={clarityTotalMinutes}
                                                        adoMinutes={weekAdoTotal}
                                                    />
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })()}
                        </TableBody>
                    </Table>
                )}

                {unmappedWorkItems.length > 0 && (
                    <div className="mt-3 px-2 py-2 bg-red-500/5 border border-red-500/20 rounded text-xs font-mono text-red-400">
                        {unmappedWorkItems.length} unmapped work items (
                        {(unmappedWorkItems.reduce((s, w) => s + w.minutes, 0) / 60).toFixed(1)}h skipped)
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function DayClarityIndicator({ adoMinutes, clarityMinutes }: { adoMinutes: number; clarityMinutes?: number }) {
    if (clarityMinutes === undefined) {
        return null;
    }

    // Both zero — no indicator needed
    if (adoMinutes === 0 && clarityMinutes === 0) {
        return null;
    }

    // Match (within 1 minute tolerance)
    if (Math.abs(clarityMinutes - adoMinutes) < 2) {
        return <CheckCircle className="w-2.5 h-2.5 text-green-500/70 mt-0.5" />;
    }

    // ADO has time but Clarity is 0 — not imported
    if (clarityMinutes === 0 && adoMinutes > 0) {
        return <XCircle className="w-2.5 h-2.5 text-primary/60 mt-0.5" />;
    }

    // Clarity has different non-zero value — red warning
    return (
        <span className="text-[9px] text-red-400/80 mt-0.5" title={`Clarity: ${(clarityMinutes / 60).toFixed(1)}h`}>
            c:{(clarityMinutes / 60).toFixed(1)}
        </span>
    );
}

function ClarityStatusIcon({ clarityMinutes, adoMinutes }: { clarityMinutes?: number; adoMinutes: number }) {
    if (clarityMinutes === undefined) {
        return null;
    }

    if (clarityMinutes === 0) {
        return (
            <span className="flex-shrink-0" title="Not imported to Clarity">
                <XCircle className="w-3.5 h-3.5 text-primary/70" />
            </span>
        );
    }

    if (Math.abs(clarityMinutes - adoMinutes) < 2) {
        return (
            <span className="flex-shrink-0" title={`Clarity: ${(clarityMinutes / 60).toFixed(1)}h (matches)`}>
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            </span>
        );
    }

    return (
        <span
            className="text-[10px] text-red-400 flex-shrink-0 whitespace-nowrap"
            title={`Clarity has ${(clarityMinutes / 60).toFixed(1)}h, ADO has ${(adoMinutes / 60).toFixed(1)}h`}
        >
            c:{(clarityMinutes / 60).toFixed(1)}h
        </span>
    );
}

function TimelogEntriesTable({ entries, adoConfig }: { entries: TimelogEntry[]; adoConfig?: AdoConfig | null }) {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.workItemId - b.workItemId);

    return (
        <div className="ml-6 mr-2 my-2 border border-white/5 rounded bg-white/[0.01]">
            <Table>
                <TableHeader>
                    <TableRow className="border-white/5">
                        <TableHead className="font-mono text-[10px] text-gray-500">Date</TableHead>
                        <TableHead className="font-mono text-[10px] text-gray-500">Hours</TableHead>
                        <TableHead className="font-mono text-[10px] text-gray-500">Work Item</TableHead>
                        <TableHead className="font-mono text-[10px] text-gray-500">Comment</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {sorted.map((e, i) => (
                        <TableRow key={`${e.date}-${e.workItemId}-${i}`} className="border-white/5">
                            <TableCell className="font-mono text-xs text-gray-500 py-1">{e.date}</TableCell>
                            <TableCell className="font-mono text-xs text-primary/80 py-1">
                                {(e.minutes / 60).toFixed(2)}h
                            </TableCell>
                            <TableCell className="py-1">
                                <div className="flex items-center gap-1.5 text-xs">
                                    <WorkItemLink id={e.workItemId} adoConfig={adoConfig} />
                                    {e.workItemType && (
                                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                                            {e.workItemType}
                                        </Badge>
                                    )}
                                    {e.timeTypeDescription && (
                                        <span className="font-mono text-gray-500">· {e.timeTypeDescription}</span>
                                    )}
                                </div>
                                {e.workItemTitle && (
                                    <div className="text-xs text-gray-400 truncate mt-0.5 max-w-xs">
                                        {e.workItemTitle}
                                    </div>
                                )}
                            </TableCell>
                            <TableCell
                                className="font-mono text-[11px] text-gray-500 max-w-32 truncate py-1"
                                title={e.comment ?? undefined}
                            >
                                {e.comment || ""}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
