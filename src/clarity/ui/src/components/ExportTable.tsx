import { Badge } from "@ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { ExternalLink } from "lucide-react";

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
    adoOrg?: string | null;
    adoProject?: string | null;
    typeColors: Record<string, { color: string; name: string }>;
}

function buildWorkItemUrl(org: string, project: string, id: number): string {
    return `${org}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

export function ExportTable({
    entries,
    entriesByDay,
    mappedWorkItemIds,
    adoOrg,
    adoProject,
    typeColors,
}: ExportTableProps) {
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
                    <TableHead className="font-mono text-xs text-gray-400">DATE</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">WORK ITEM</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">TYPE</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">HOURS</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">COMMENT</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">STATUS</TableHead>
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
                                    {adoOrg && adoProject ? (
                                        <a
                                            href={buildWorkItemUrl(adoOrg, adoProject, entry.workItemId)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 font-mono text-sm text-amber-400 hover:text-amber-300 hover:underline"
                                        >
                                            #{entry.workItemId}
                                            <ExternalLink className="w-3 h-3" />
                                        </a>
                                    ) : (
                                        <span className="font-mono text-sm text-amber-400">#{entry.workItemId}</span>
                                    )}
                                    {entry.workItemTitle && (
                                        <span className="text-sm text-gray-400">{entry.workItemTitle}</span>
                                    )}
                                    {entry.workItemType && typeColors[entry.workItemType] && (
                                        <span
                                            className="text-xs font-mono px-1.5 py-0.5 rounded"
                                            style={{
                                                borderLeft: `3px solid #${typeColors[entry.workItemType].color}`,
                                                backgroundColor: `#${typeColors[entry.workItemType].color}18`,
                                                color: `#${typeColors[entry.workItemType].color}`,
                                            }}
                                        >
                                            {entry.workItemType}
                                        </span>
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
                                        MAPPED
                                    </Badge>
                                ) : (
                                    <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
                                        UNMAPPED
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
