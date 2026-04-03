import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { ArrowDownUp, TableProperties } from "lucide-react";
import { useMemo, useState } from "react";
import type { DistrictComparison } from "./types";

type SortKey = "district" | "median" | "yield" | "dom" | "discount" | "volume";

export function DistrictDetailTable({ comparisons }: { comparisons: DistrictComparison[] }) {
    const [sortKey, setSortKey] = useState<SortKey>("median");
    const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

    const rows = useMemo(() => {
        const mapped = comparisons.map((comparison) => ({
            district: comparison.district,
            median: comparison.summary.medianPricePerM2,
            yield: comparison.exportData.analysis.yield.atMarketPrice.grossYield,
            dom: comparison.summary.daysOnMarket,
            discount: comparison.exportData.analysis.discount.medianDiscount,
            volume: comparison.summary.salesCount,
            rentals: comparison.summary.rentalCount,
            percentile: comparison.summary.targetPercentile,
        }));

        return mapped.sort((left, right) => {
            const leftValue = left[sortKey];
            const rightValue = right[sortKey];

            if (typeof leftValue === "string" && typeof rightValue === "string") {
                return sortDir === "asc" ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
            }

            return sortDir === "asc" ? Number(leftValue) - Number(rightValue) : Number(rightValue) - Number(leftValue);
        });
    }, [comparisons, sortDir, sortKey]);

    function handleSort(nextKey: SortKey) {
        if (sortKey === nextKey) {
            setSortDir((current) => (current === "asc" ? "desc" : "asc"));
            return;
        }

        setSortKey(nextKey);
        setSortDir(nextKey === "district" ? "asc" : "desc");
    }

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-mono text-amber-400">
                    <TableProperties className="w-4 h-4" />
                    District detail table
                </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
                <Table>
                    <TableHeader>
                        <TableRow className="border-white/5 hover:bg-transparent">
                            <SortableHead label="District" onClick={() => handleSort("district")} />
                            <SortableHead label="Median CZK/m²" align="right" onClick={() => handleSort("median")} />
                            <SortableHead
                                label="Market Gross Yield"
                                align="right"
                                onClick={() => handleSort("yield")}
                            />
                            <SortableHead label="DOM" align="right" onClick={() => handleSort("dom")} />
                            <SortableHead label="Discount" align="right" onClick={() => handleSort("discount")} />
                            <SortableHead label="Sold" align="right" onClick={() => handleSort("volume")} />
                            <TableHead className="text-right text-[10px] font-mono text-gray-500">Rentals</TableHead>
                            <TableHead className="text-right text-[10px] font-mono text-gray-500">Percentile</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.district} className="border-white/5 hover:bg-white/[0.02]">
                                <TableCell className="font-mono text-xs text-gray-100">{row.district}</TableCell>
                                <TableCell className="text-right font-mono text-xs text-cyan-300">
                                    {Math.round(row.median).toLocaleString("cs-CZ")}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-emerald-300">
                                    {row.yield.toFixed(2)}%
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-gray-300">
                                    {Math.round(row.dom)}d
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-amber-300">
                                    {row.discount.toFixed(1)}%
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-gray-300">
                                    {row.volume}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-gray-300">
                                    {row.rentals}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-gray-300">
                                    {row.percentile.toFixed(0)}th
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}

function SortableHead({
    label,
    onClick,
    align = "left",
}: {
    label: string;
    onClick: () => void;
    align?: "left" | "right";
}) {
    return (
        <TableHead className={align === "right" ? "text-right" : undefined}>
            <Button
                variant="ghost"
                size="sm"
                onClick={onClick}
                className="h-auto px-0 font-mono text-[10px] text-gray-500 hover:bg-transparent hover:text-gray-300"
            >
                {label}
                <ArrowDownUp className="w-3 h-3" />
            </Button>
        </TableHead>
    );
}
