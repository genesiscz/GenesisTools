import type { CheckRecord } from "@app/monitor/lib/types";
import { StatusBadge } from "@app/monitor/ui/components/status-badge";
import { formatDateTime, formatLatency } from "@app/monitor/ui/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@genesiscz/utils/ui/components/table";

const HEAD = "font-mono text-[0.65rem] uppercase tracking-[0.22em] text-muted-foreground";

export function ChecksTable({ checks }: { checks: CheckRecord[] }) {
    if (checks.length === 0) {
        return <p className="p-6 text-sm text-muted-foreground">No checks recorded yet.</p>;
    }

    return (
        <div className="mon-panel mon-scroll max-h-[32rem] overflow-auto rounded-3xl">
            <Table>
                <TableHeader>
                    <TableRow className="border-primary/20 hover:bg-transparent">
                        <TableHead className={HEAD}>Status</TableHead>
                        <TableHead className={HEAD}>When</TableHead>
                        <TableHead className={HEAD}>Latency</TableHead>
                        <TableHead className={HEAD}>HTTP</TableHead>
                        <TableHead className={HEAD}>Detail</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {checks.map((check) => (
                        <TableRow key={check.id} className="border-primary/10 hover:bg-primary/[0.05]">
                            <TableCell>
                                <StatusBadge status={check.status} />
                            </TableCell>
                            <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                {formatDateTime(check.checkedAt)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{formatLatency(check.latencyMs)}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                                {check.httpStatus ?? "—"}
                            </TableCell>
                            <TableCell className="max-w-xl text-xs text-muted-foreground">
                                <span className="line-clamp-2" title={check.detail}>
                                    {check.detail}
                                </span>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
