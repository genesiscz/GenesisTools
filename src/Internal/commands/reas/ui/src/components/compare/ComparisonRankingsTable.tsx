import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { Medal } from "lucide-react";
import { useMemo } from "react";
import { fmt, pct } from "../../lib/format";
import { GRADE_COLORS, getScoreCardModel } from "../analysis/display-model";
import type { DistrictComparison } from "./types";

interface ComparisonRankingsTableProps {
    comparisons: DistrictComparison[];
}

export function ComparisonRankingsTable({ comparisons }: ComparisonRankingsTableProps) {
    const ranked = useMemo(
        () =>
            [...comparisons]
                .map((comparison) => ({
                    comparison,
                    score: getScoreCardModel(comparison.exportData),
                }))
                .sort((a, b) => b.score.score - a.score.score),
        [comparisons]
    );

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader>
                <CardTitle className="text-sm font-mono text-amber-400 flex items-center gap-2">
                    <Medal className="w-4 h-4" />
                    Ranking table
                </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
                <Table>
                    <TableHeader>
                        <TableRow className="border-white/5 hover:bg-transparent">
                            <TableHead className="text-[10px] font-mono text-gray-500">Rank</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500">District</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">Score</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                Median CZK/m²
                            </TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">Net Yield</TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                Gross Yield
                            </TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                Days on Market
                            </TableHead>
                            <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                Target %ile
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {ranked.map(({ comparison, score }, index) => (
                            <TableRow key={comparison.district} className="border-white/5 hover:bg-white/[0.02]">
                                <TableCell className="font-mono text-xs text-gray-400">#{index + 1}</TableCell>
                                <TableCell className="font-mono text-xs text-gray-200">
                                    <div className="flex items-center gap-2">
                                        <span>{comparison.district}</span>
                                        <Badge
                                            variant="outline"
                                            className={`font-mono text-[10px] ${GRADE_COLORS[score.grade]}`}
                                        >
                                            {score.grade}
                                        </Badge>
                                    </div>
                                </TableCell>
                                <TableCell className="font-mono text-xs text-right text-gray-200">
                                    {score.score}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-right text-cyan-400">
                                    {fmt(Math.round(comparison.summary.medianPricePerM2))}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-right text-emerald-400">
                                    {pct(comparison.summary.netYield, { digits: 2 })}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-right text-gray-300">
                                    {pct(comparison.summary.grossYield, { digits: 2 })}
                                </TableCell>
                                <TableCell className="font-mono text-xs text-right text-gray-400">
                                    {Math.round(comparison.summary.daysOnMarket)}d
                                </TableCell>
                                <TableCell className="font-mono text-xs text-right text-amber-300">
                                    {comparison.summary.targetPercentile.toFixed(0)}th
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}
