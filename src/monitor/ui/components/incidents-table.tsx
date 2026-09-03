import type { IncidentWithWatcher } from "@app/monitor/lib/types";
import { StatusBadge } from "@app/monitor/ui/components/status-badge";
import { formatDateTime, formatSpan } from "@app/monitor/ui/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@genesiscz/utils/ui/components/table";
import { Link } from "@tanstack/react-router";

const HEAD = "font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground";

export function IncidentsTable({
    incidents,
    showWatcher = true,
}: {
    incidents: IncidentWithWatcher[];
    showWatcher?: boolean;
}) {
    if (incidents.length === 0) {
        return <p className="p-6 text-sm text-muted-foreground">No incidents recorded.</p>;
    }

    return (
        <div className="mon-panel overflow-hidden rounded-3xl">
            <Table>
                <TableHeader>
                    <TableRow className="border-primary/20 hover:bg-transparent">
                        <TableHead className={HEAD}>Severity</TableHead>
                        {showWatcher && <TableHead className={HEAD}>Watcher</TableHead>}
                        <TableHead className={HEAD}>Started</TableHead>
                        <TableHead className={HEAD}>Duration</TableHead>
                        <TableHead className={HEAD}>Detail</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {incidents.map((incident) => (
                        <TableRow key={incident.id} className="border-primary/10 hover:bg-primary/[0.05]">
                            <TableCell>
                                <StatusBadge status={incident.status} />
                            </TableCell>
                            {showWatcher && (
                                <TableCell>
                                    <Link
                                        to="/watchers/$id"
                                        params={{ id: String(incident.watcherId) }}
                                        className="font-medium text-foreground hover:text-primary"
                                    >
                                        {incident.watcherName}
                                    </Link>
                                </TableCell>
                            )}
                            <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                {formatDateTime(incident.startedAt)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap font-mono text-xs">
                                {incident.endedAt ? (
                                    formatSpan(incident.startedAt, incident.endedAt)
                                ) : (
                                    <span className="text-amber-200">
                                        {formatSpan(incident.startedAt, null)} · open
                                    </span>
                                )}
                            </TableCell>
                            <TableCell className="max-w-xl text-xs text-muted-foreground">
                                <span className="line-clamp-2" title={incident.detail}>
                                    {incident.detail}
                                </span>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
