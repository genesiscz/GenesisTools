import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { cn } from "@ui/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { fmt, fmtDateTime, pct } from "../../lib/format";
import { GRADE_COLORS } from "../analysis/display-model";

interface HistoryEntry {
    id: number;
    district: string;
    constructionType: string;
    disposition: string | null;
    investmentGrade: string | null;
    netYield: number | null;
    medianPricePerM2: number | null;
    comparablesCount: number | null;
    createdAt: string;
}

interface HistoryTableProps {
    entries: HistoryEntry[];
    districtFilter: string;
}

const PAGE_SIZE = 20;

export function HistoryTable({ entries, districtFilter }: HistoryTableProps) {
    const [page, setPage] = useState(0);

    const filtered = useMemo(() => {
        if (!districtFilter) {
            return entries;
        }

        return entries.filter((e) => e.district === districtFilter);
    }, [entries, districtFilter]);

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const goNext = () => setPage((p) => Math.min(p + 1, totalPages - 1));
    const goPrev = () => setPage((p) => Math.max(p - 1, 0));

    if (filtered.length === 0) {
        return (
            <div className="border border-white/5 rounded-lg p-6 text-center">
                <p className="text-xs font-mono text-gray-500">No history entries found</p>
            </div>
        );
    }

    return (
        <div>
            <Table>
                <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                        <TableHead className="text-[10px] font-mono text-gray-500">Date</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500">District</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500">Type</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500">Disp.</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500 text-center">Score</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">Net Yield</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">Median CZK/m2</TableHead>
                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">Comps</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {paged.map((entry) => (
                        <TableRow key={entry.id} className="border-white/5 hover:bg-white/[0.02]">
                            <TableCell className="text-xs font-mono text-gray-400">
                                {formatDate(entry.createdAt)}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-gray-300">{entry.district}</TableCell>
                            <TableCell className="text-xs font-mono text-gray-400">{entry.constructionType}</TableCell>
                            <TableCell className="text-xs font-mono text-gray-400">
                                {entry.disposition ?? "All"}
                            </TableCell>
                            <TableCell className="text-center">
                                {entry.investmentGrade ? (
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "text-[10px] font-mono font-bold",
                                            GRADE_COLORS[entry.investmentGrade] ?? ""
                                        )}
                                    >
                                        {entry.investmentGrade}
                                    </Badge>
                                ) : (
                                    <span className="text-gray-600 text-xs">--</span>
                                )}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-cyan-400 text-right">
                                {entry.netYield !== null ? pct(entry.netYield, { digits: 1 }) : "--"}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-gray-300 text-right">
                                {entry.medianPricePerM2 !== null ? fmt(entry.medianPricePerM2) : "--"}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-gray-400 text-right">
                                {entry.comparablesCount ?? "--"}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between mt-3 px-1">
                    <span className="text-[10px] font-mono text-gray-500">
                        {filtered.length} entries, page {page + 1}/{totalPages}
                    </span>
                    <div className="flex items-center gap-1">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={goPrev}
                            disabled={page === 0}
                            className="h-6 w-6 p-0 border-white/10"
                        >
                            <ChevronLeft className="w-3 h-3" />
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={goNext}
                            disabled={page >= totalPages - 1}
                            className="h-6 w-6 p-0 border-white/10"
                        >
                            <ChevronRight className="w-3 h-3" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

function formatDate(iso: string): string {
    return fmtDateTime(iso, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
