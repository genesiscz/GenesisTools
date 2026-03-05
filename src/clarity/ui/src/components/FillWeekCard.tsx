import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Badge } from "@ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";

interface WeekEntry {
    clarityTaskName: string;
    clarityTaskCode: string;
    dayValues: Record<string, number>;
    totalMinutes: number;
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
    selected: boolean;
    onToggle: () => void;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getWorkDays(periodStart: string): Array<{ label: string; date: string }> {
    const start = new Date(periodStart);
    const days: Array<{ label: string; date: string }> = [];

    for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setDate(date.getDate() + d);
        const dow = date.getDay();

        if (dow >= 1 && dow <= 5) {
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            days.push({ label: `${DAY_NAMES[dow]} ${date.getDate()}`, date: dateStr });
        }
    }

    return days;
}

export function FillWeekCard({
    timesheetId,
    periodStart,
    periodFinish,
    entries,
    unmappedWorkItems,
    selected,
    onToggle,
}: FillWeekCardProps) {
    const startDate = periodStart.split("T")[0];
    const endDate = periodFinish.split("T")[0];
    const workDays = getWorkDays(periodStart);

    return (
        <Card className={`border-amber-500/20 ${selected ? "ring-1 ring-amber-500/40" : ""}`}>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-mono text-gray-300 flex items-center gap-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={selected}
                                onChange={onToggle}
                                className="accent-amber-500"
                            />
                            WEEK: {startDate} to {endDate}
                        </label>
                    </CardTitle>
                    <Badge variant="outline" className="font-mono text-xs">
                        TS#{timesheetId}
                    </Badge>
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
                            <TableRow className="border-amber-500/20">
                                <TableHead className="font-mono text-xs text-gray-400">CLARITY TASK</TableHead>
                                {workDays.map((d) => (
                                    <TableHead key={d.date} className="font-mono text-xs text-gray-400 text-center">
                                        {d.label}
                                    </TableHead>
                                ))}
                                <TableHead className="font-mono text-xs text-gray-400 text-right">TOTAL</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {entries.map((entry) => (
                                <TableRow key={entry.clarityTaskCode} className="border-white/5">
                                    <TableCell className="font-mono text-sm text-gray-300">
                                        <div className="max-w-[200px] truncate" title={entry.clarityTaskName}>
                                            {entry.clarityTaskName}
                                        </div>
                                    </TableCell>
                                    {workDays.map((d) => {
                                        const mins = entry.dayValues[d.date] ?? 0;
                                        return (
                                            <TableCell
                                                key={d.date}
                                                className={`font-mono text-xs text-center ${mins > 0 ? "text-amber-400" : "text-gray-600"}`}
                                            >
                                                {mins > 0 ? `${(mins / 60).toFixed(1)}h` : "-"}
                                            </TableCell>
                                        );
                                    })}
                                    <TableCell className="font-mono text-sm text-right font-bold text-gray-200">
                                        {(entry.totalMinutes / 60).toFixed(1)}h
                                    </TableCell>
                                </TableRow>
                            ))}
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
