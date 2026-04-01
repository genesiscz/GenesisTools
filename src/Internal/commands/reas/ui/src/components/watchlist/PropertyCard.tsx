import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

const GRADE_COLORS: Record<string, string> = {
    A: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
    B: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
    C: "text-amber-400 border-amber-500/30 bg-amber-500/10",
    D: "text-orange-400 border-orange-500/30 bg-orange-500/10",
    F: "text-red-400 border-red-500/30 bg-red-500/10",
};

function getStalenessInfo(lastAnalyzedAt: string | null): {
    label: string;
    color: string;
} {
    if (!lastAnalyzedAt) {
        return { label: "Never analyzed", color: "text-gray-500 border-gray-500/30 bg-gray-500/10" };
    }

    const diff = Date.now() - new Date(lastAnalyzedAt).getTime();
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 1) {
        return { label: "< 1 day ago", color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" };
    }

    if (days < 7) {
        return { label: `${Math.floor(days)}d ago`, color: "text-amber-400 border-amber-500/30 bg-amber-500/10" };
    }

    return { label: `${Math.floor(days)}d ago`, color: "text-red-400 border-red-500/30 bg-red-500/10" };
}

interface PropertyCardProps {
    property: SavedPropertyRow;
    onRefresh: (id: number) => Promise<void>;
    onDelete: (id: number) => void;
}

export function PropertyCard({ property, onRefresh, onDelete }: PropertyCardProps) {
    const [refreshing, setRefreshing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const staleness = getStalenessInfo(property.last_analyzed_at);
    const gradeStyle = property.last_grade ? (GRADE_COLORS[property.last_grade] ?? "") : "";

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await onRefresh(property.id);
        } finally {
            setRefreshing(false);
        }
    }, [property.id, onRefresh]);

    const handleDelete = useCallback(() => {
        if (confirmDelete) {
            onDelete(property.id);
            setConfirmDelete(false);
        } else {
            setConfirmDelete(true);
            setTimeout(() => setConfirmDelete(false), 3000);
        }
    }, [property.id, onDelete, confirmDelete]);

    return (
        <Card className="border-white/5 bg-white/[0.02] hover:border-amber-500/10 transition-colors">
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-mono text-gray-200 truncate">{property.name}</CardTitle>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {property.last_grade && (
                            <Badge variant="outline" className={cn("text-xs font-mono font-bold", gradeStyle)}>
                                {property.last_grade}
                            </Badge>
                        )}

                        <Badge variant="outline" className={cn("text-[10px] font-mono", staleness.color)}>
                            {staleness.label}
                        </Badge>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {/* Property details */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
                    <div className="text-gray-500">District</div>
                    <div className="text-gray-300 text-right">{property.district}</div>

                    <div className="text-gray-500">Type</div>
                    <div className="text-gray-300 text-right">{property.construction_type}</div>

                    <div className="text-gray-500">Disposition</div>
                    <div className="text-gray-300 text-right">{property.disposition ?? "All"}</div>

                    {property.last_net_yield !== null && (
                        <>
                            <div className="text-gray-500">Net Yield</div>
                            <div className="text-cyan-400 text-right">{property.last_net_yield.toFixed(1)}%</div>
                        </>
                    )}

                    {property.last_median_price_per_m2 !== null && (
                        <>
                            <div className="text-gray-500">Median CZK/m2</div>
                            <div className="text-gray-300 text-right">
                                {property.last_median_price_per_m2.toLocaleString("cs-CZ")}
                            </div>
                        </>
                    )}
                </div>

                {/* Notes */}
                {property.notes && (
                    <p className="text-[10px] font-mono text-gray-500 italic border-t border-white/5 pt-2">
                        {property.notes}
                    </p>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="flex-1 h-7 text-xs font-mono border-cyan-500/20 text-cyan-400 hover:bg-cyan-500/10"
                    >
                        {refreshing ? (
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        ) : (
                            <RefreshCw className="w-3 h-3 mr-1" />
                        )}
                        Refresh
                    </Button>

                    <Button
                        size="sm"
                        variant="outline"
                        onClick={handleDelete}
                        className={cn(
                            "h-7 text-xs font-mono",
                            confirmDelete
                                ? "border-red-500/40 text-red-400 bg-red-500/10"
                                : "border-red-500/20 text-red-400 hover:bg-red-500/10"
                        )}
                    >
                        <Trash2 className="w-3 h-3 mr-1" />
                        {confirmDelete ? "Confirm" : "Delete"}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
