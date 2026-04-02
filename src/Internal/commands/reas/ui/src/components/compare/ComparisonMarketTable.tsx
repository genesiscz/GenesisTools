import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { Database } from "lucide-react";
import type { DistrictComparison } from "./types";

interface ComparisonMarketTableProps {
    comparisons: DistrictComparison[];
}

export function ComparisonMarketTable({ comparisons }: ComparisonMarketTableProps) {
    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader>
                <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                    <Database className="w-4 h-4" />
                    Market depth
                </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
                <Table>
                    <TableHeader>
                        <TableRow className="border-white/5 hover:bg-transparent">
                            <TableHead className="text-[10px] font-mono text-gray-500">District</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">Sold</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                Active Sales
                            </TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">Rentals</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                Median Discount
                            </TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">P25-P75</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">Latest YoY</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {comparisons.map((comparison) => {
                            const latestSnapshot = comparison.snapshots[comparison.snapshots.length - 1] ?? null;
                            const comparables = comparison.exportData.analysis.comparables;

                            return (
                                <TableRow key={comparison.district} className="border-white/5 hover:bg-white/[0.02]">
                                    <TableCell className="font-mono text-xs text-gray-200">
                                        {comparison.district}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-right text-gray-300">
                                        {comparison.summary.salesCount}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-right text-gray-300">
                                        {comparison.exportData.listings.activeSales.length}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-right text-gray-300">
                                        {comparison.summary.rentalCount}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-right text-cyan-400">
                                        {comparison.exportData.analysis.discount.medianDiscount.toFixed(1)}%
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-right text-gray-400">
                                        {Math.round(comparables.p25).toLocaleString("cs-CZ")} -{" "}
                                        {Math.round(comparables.p75).toLocaleString("cs-CZ")}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-right text-amber-300">
                                        {latestSnapshot?.yoyChange !== null && latestSnapshot?.yoyChange !== undefined
                                            ? `${latestSnapshot.yoyChange >= 0 ? "+" : ""}${latestSnapshot.yoyChange.toFixed(1)}%`
                                            : "--"}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}
