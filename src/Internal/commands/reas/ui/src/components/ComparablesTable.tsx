import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { cn } from "@ui/lib/utils";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, LayoutList } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

type SortKey = "address" | "disposition" | "area" | "price" | "pricePerM2" | "daysOnMarket";
type SortDirection = "asc" | "desc";

interface SortState {
    key: SortKey;
    direction: SortDirection;
}

interface ComparablesTableProps {
    data: DashboardExport;
}

const COLUMN_DEFS: Array<{ key: SortKey; label: string; align?: "right" }> = [
    { key: "address", label: "Address" },
    { key: "disposition", label: "Disposition" },
    { key: "area", label: "Area" },
    { key: "price", label: "Sold Price", align: "right" },
    { key: "pricePerM2", label: "CZK/m\u00B2", align: "right" },
    { key: "daysOnMarket", label: "Days on Market", align: "right" },
];

function formatNumber(n: number): string {
    return n.toLocaleString("cs-CZ");
}

export function ComparablesTable({ data }: ComparablesTableProps) {
    const [sort, setSort] = useState<SortState>({ key: "pricePerM2", direction: "asc" });
    const listings = data.listings.sold;

    const handleSort = useCallback((key: SortKey) => {
        setSort((prev) => ({
            key,
            direction: prev.key === key && prev.direction === "asc" ? "desc" : "asc",
        }));
    }, []);

    const sorted = useMemo(() => {
        const items = [...listings];
        const { key, direction } = sort;
        const mult = direction === "asc" ? 1 : -1;

        items.sort((a, b) => {
            const aVal = a[key] ?? 0;
            const bVal = b[key] ?? 0;

            if (typeof aVal === "string" && typeof bVal === "string") {
                return mult * aVal.localeCompare(bVal);
            }

            return mult * (Number(aVal) - Number(bVal));
        });

        return items;
    }, [listings, sort]);

    return (
        <Card className="border-white/5">
            <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                    <LayoutList className="h-4 w-4 text-amber-400" />
                    Comparables
                    <Badge variant="outline" className="ml-2 font-mono text-[10px]">
                        {listings.length}
                    </Badge>
                </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-white/5 hover:bg-transparent">
                                {COLUMN_DEFS.map((col) => (
                                    <TableHead
                                        key={col.key}
                                        className={cn(
                                            "font-mono text-[10px] uppercase tracking-wider text-gray-500 cursor-pointer select-none hover:text-amber-400 transition-colors",
                                            col.align === "right" && "text-right"
                                        )}
                                        onClick={() => handleSort(col.key)}
                                    >
                                        <span className="inline-flex items-center gap-1">
                                            {col.label}
                                            <SortIndicator active={sort.key === col.key} direction={sort.direction} />
                                        </span>
                                    </TableHead>
                                ))}
                                <TableHead className="w-8" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {sorted.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={7}
                                        className="text-center text-xs text-muted-foreground font-mono py-8"
                                    >
                                        No comparables found
                                    </TableCell>
                                </TableRow>
                            ) : (
                                sorted.map((item, idx) => (
                                    <TableRow
                                        key={`${item.address}-${idx}`}
                                        className="border-white/5 hover:bg-amber-500/5"
                                    >
                                        <TableCell className="font-mono text-xs text-gray-300 max-w-[200px] truncate">
                                            {item.address}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className="font-mono text-[10px] border-white/10">
                                                {item.disposition}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-gray-400">
                                            {item.area} m²
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-right text-gray-300">
                                            {formatNumber(item.price)} CZK
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-right text-cyan-400">
                                            {formatNumber(Math.round(item.pricePerM2))}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-right text-gray-400">
                                            {item.daysOnMarket != null ? `${item.daysOnMarket}d` : "\u2014"}
                                        </TableCell>
                                        <TableCell>
                                            {item.link && (
                                                <a
                                                    href={item.link}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-gray-600 hover:text-amber-400 transition-colors"
                                                >
                                                    <ExternalLink className="h-3 w-3" />
                                                </a>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>

                {/* Summary stats */}
                {listings.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-4 px-6 text-xs font-mono text-gray-500">
                        <span>
                            Median:{" "}
                            <span className="text-cyan-400">
                                {formatNumber(Math.round(data.analysis.comparables.median))} CZK/m²
                            </span>
                        </span>
                        <span>
                            P25:{" "}
                            <span className="text-gray-400">
                                {formatNumber(Math.round(data.analysis.comparables.p25))}
                            </span>
                        </span>
                        <span>
                            P75:{" "}
                            <span className="text-gray-400">
                                {formatNumber(Math.round(data.analysis.comparables.p75))}
                            </span>
                        </span>
                        <span>
                            Target:{" "}
                            <span className="text-amber-400">
                                {data.analysis.comparables.targetPercentile.toFixed(0)}th percentile
                            </span>
                        </span>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function SortIndicator({ active, direction }: { active: boolean; direction: SortDirection }) {
    if (!active) {
        return <ArrowUpDown className="h-3 w-3 opacity-30" />;
    }

    return direction === "asc" ? (
        <ArrowUp className="h-3 w-3 text-amber-400" />
    ) : (
        <ArrowDown className="h-3 w-3 text-amber-400" />
    );
}
