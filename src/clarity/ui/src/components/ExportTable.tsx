import type { WorkItemTypeColor } from "@app/azure-devops/lib/work-item-enrichment";
import { Badge } from "@ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import type { AdoConfig } from "./WorkItemLink";
import { TypeBadge, WorkItemLink } from "./WorkItemLink";

interface ExportEntry {
    date: string;
    workItemId: number;
    minutes: number;
    workItemTitle: string;
    workItemType?: string;
    timeTypeDescription: string;
    comment: string | null;
}

interface ExportTableProps {
    entries: ExportEntry[];
    entriesByDay: Record<string, number>;
    mappedWorkItemIds: Set<number>;
    adoConfig?: AdoConfig | null;
    typeColors: Record<string, WorkItemTypeColor>;
}

export function ExportTable({ entries, entriesByDay, mappedWorkItemIds, adoConfig, typeColors }: ExportTableProps) {
    // Group entries by date
    const byDate = new Map<string, ExportEntry[]>();

    for (const entry of entries) {
        const list = byDate.get(entry.date) ?? [];
        list.push(entry);
        byDate.set(entry.date, list);
    }

    const sortedDates = [...byDate.keys()].sort();

    if (sortedDates.length === 0) {
        return (
            <div className="text-center py-12 text-gray-500 font-mono text-sm">
                No timelog entries found for this month.
            </div>
        );
    }

    return (
        <Table>
            <TableHeader>
                <TableRow className="border-amber-500/20">
                    <TableHead className="font-mono text-xs text-gray-400">Date</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">Work Item</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">Type</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">Hours</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">Comment</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">Status</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {sortedDates.map((date) => {
                    const dayEntries = byDate.get(date) ?? [];
                    const dayTotal = entriesByDay[date] ?? 0;

                    return dayEntries.map((entry, i) => (
                        <TableRow key={`${date}-${entry.workItemId}`} className="border-white/5 hover:bg-amber-500/5">
                            <TableCell className="font-mono text-sm text-gray-400">
                                {i === 0 ? (
                                    <div>
                                        <div>{date}</div>
                                        <div className="text-xs text-gray-500">{(dayTotal / 60).toFixed(1)}h total</div>
                                    </div>
                                ) : null}
                            </TableCell>
                            <TableCell>
                                <div className="flex items-center gap-2">
                                    <WorkItemLink
                                        id={entry.workItemId}
                                        title={entry.workItemTitle}
                                        adoConfig={adoConfig}
                                    />
                                    {entry.workItemType && (
                                        <TypeBadge
                                            typeName={entry.workItemType}
                                            color={typeColors[entry.workItemType]}
                                        />
                                    )}
                                </div>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-gray-400">
                                {entry.timeTypeDescription || "—"}
                            </TableCell>
                            <TableCell className="font-mono text-sm text-gray-300">
                                {(entry.minutes / 60).toFixed(2)}h
                            </TableCell>
                            <TableCell
                                className="font-mono text-xs text-gray-500 max-w-48 truncate"
                                title={entry.comment ?? undefined}
                            >
                                {entry.comment || ""}
                            </TableCell>
                            <TableCell>
                                {mappedWorkItemIds.has(entry.workItemId) ? (
                                    <Badge variant="outline" className="text-xs border-green-500/30 text-green-400">
                                        Mapped
                                    </Badge>
                                ) : (
                                    <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
                                        Unmapped
                                    </Badge>
                                )}
                            </TableCell>
                        </TableRow>
                    ));
                })}
            </TableBody>
        </Table>
    );
}
