import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@ui/components/table";
import { Button } from "@ui/components/button";
import { Badge } from "@ui/components/badge";
import { Unlink } from "lucide-react";

interface MappingRow {
    clarityTaskId: number;
    clarityTaskName: string;
    clarityTaskCode: string;
    clarityInvestmentName: string;
    clarityInvestmentCode: string;
    adoWorkItemId: number;
    adoWorkItemTitle: string;
    adoWorkItemType?: string;
}

interface MappingTableProps {
    mappings: MappingRow[];
    onRemove: (adoWorkItemId: number) => void;
}

export function MappingTable({ mappings, onRemove }: MappingTableProps) {
    if (mappings.length === 0) {
        return (
            <div className="text-center py-12 text-gray-500 font-mono text-sm">
                No mappings configured. Use{" "}
                <code className="text-amber-400">tools clarity link-workitems</code> to create mappings.
            </div>
        );
    }

    return (
        <Table>
            <TableHeader>
                <TableRow className="border-amber-500/20">
                    <TableHead className="font-mono text-xs text-gray-400">CLARITY PROJECT</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">CODE</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">ADO WORK ITEM</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400">ADO ID</TableHead>
                    <TableHead className="font-mono text-xs text-gray-400 w-16" />
                </TableRow>
            </TableHeader>
            <TableBody>
                {mappings.map((m) => (
                    <TableRow key={m.adoWorkItemId} className="border-white/5 hover:bg-amber-500/5">
                        <TableCell>
                            <div className="font-mono text-sm text-gray-300">{m.clarityTaskName}</div>
                            <div className="font-mono text-xs text-gray-500">{m.clarityInvestmentName}</div>
                        </TableCell>
                        <TableCell>
                            <Badge variant="outline" className="font-mono text-xs">
                                {m.clarityTaskCode}
                            </Badge>
                        </TableCell>
                        <TableCell>
                            <div className="font-mono text-sm text-gray-300">{m.adoWorkItemTitle}</div>
                            {m.adoWorkItemType && (
                                <div className="font-mono text-xs text-gray-500">{m.adoWorkItemType}</div>
                            )}
                        </TableCell>
                        <TableCell>
                            <span className="font-mono text-sm text-amber-400">#{m.adoWorkItemId}</span>
                        </TableCell>
                        <TableCell>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onRemove(m.adoWorkItemId)}
                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                            >
                                <Unlink className="w-3.5 h-3.5" />
                            </Button>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}
