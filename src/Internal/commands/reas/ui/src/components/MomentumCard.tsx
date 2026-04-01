import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Activity, ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useMemo } from "react";

type Direction = "rising" | "stable" | "declining";
type MomentumType = "accelerating" | "linear" | "decelerating";

interface MomentumData {
    direction: Direction;
    velocityPerQuarter: number;
    momentum: MomentumType;
    confidence: number;
}

interface MomentumCardProps {
    data: DashboardExport;
}

function computeMomentum(data: DashboardExport): MomentumData {
    const trends = data.analysis.trends;

    if (trends.length < 2) {
        return { direction: "stable", velocityPerQuarter: 0, momentum: "linear", confidence: 0 };
    }

    // Compute average change across periods
    const changes: number[] = [];

    for (let i = 1; i < trends.length; i++) {
        const prev = trends[i - 1].medianPricePerM2;
        const curr = trends[i].medianPricePerM2;

        if (prev > 0) {
            changes.push(((curr - prev) / prev) * 100);
        }
    }

    if (changes.length === 0) {
        return { direction: "stable", velocityPerQuarter: 0, momentum: "linear", confidence: 0 };
    }

    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;

    let direction: Direction;

    if (avgChange > 1) {
        direction = "rising";
    } else if (avgChange < -1) {
        direction = "declining";
    } else {
        direction = "stable";
    }

    // Momentum: are changes accelerating or decelerating?
    let momentum: MomentumType = "linear";

    if (changes.length >= 2) {
        const recentChange = changes[changes.length - 1];
        const earlierChange = changes[0];
        const diff = Math.abs(recentChange) - Math.abs(earlierChange);

        if (diff > 1) {
            momentum = "accelerating";
        } else if (diff < -1) {
            momentum = "decelerating";
        }
    }

    // Confidence based on data count
    const totalCount = trends.reduce((s, t) => s + t.count, 0);
    const confidence = Math.min(100, Math.round((totalCount / 50) * 100));

    return {
        direction,
        velocityPerQuarter: avgChange,
        momentum,
        confidence,
    };
}

const DIRECTION_CONFIG: Record<Direction, { icon: typeof ArrowUp; color: string; label: string }> = {
    rising: { icon: ArrowUp, color: "text-green-400", label: "Rising" },
    stable: { icon: ArrowRight, color: "text-amber-400", label: "Stable" },
    declining: { icon: ArrowDown, color: "text-red-400", label: "Declining" },
};

const MOMENTUM_CONFIG: Record<MomentumType, { color: string; label: string }> = {
    accelerating: { color: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10", label: "Accelerating" },
    linear: { color: "text-gray-400 border-white/10 bg-white/5", label: "Linear" },
    decelerating: { color: "text-orange-400 border-orange-500/30 bg-orange-500/10", label: "Decelerating" },
};

export function MomentumCard({ data }: MomentumCardProps) {
    const { direction, velocityPerQuarter, momentum, confidence } = useMemo(() => computeMomentum(data), [data]);

    const dirConfig = DIRECTION_CONFIG[direction];
    const momConfig = MOMENTUM_CONFIG[momentum];
    const DirectionIcon = dirConfig.icon;

    return (
        <Card className="border-white/5">
            <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                    <Activity className="h-4 w-4 text-amber-400" />
                    Market Momentum
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Direction */}
                <div className="flex items-center gap-4">
                    <div
                        className={cn(
                            "flex h-12 w-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02]",
                            dirConfig.color
                        )}
                    >
                        <DirectionIcon className="h-6 w-6" />
                    </div>
                    <div>
                        <div className={cn("text-lg font-bold font-mono", dirConfig.color)}>{dirConfig.label}</div>
                        <div className="text-xs font-mono text-gray-500">
                            {velocityPerQuarter >= 0 ? "+" : ""}
                            {velocityPerQuarter.toFixed(1)}% per period
                        </div>
                    </div>
                </div>

                {/* Momentum indicator */}
                <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-gray-500">Momentum</span>
                    <Badge className={cn("font-mono text-[10px]", momConfig.color)}>{momConfig.label}</Badge>
                </div>

                {/* Confidence */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-gray-500">Confidence</span>
                        <span className="text-xs font-mono text-gray-400">{confidence}%</span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
                        <div
                            className={cn(
                                "h-full rounded-full transition-all duration-500",
                                confidence >= 70 ? "bg-green-500" : confidence >= 40 ? "bg-amber-500" : "bg-red-500"
                            )}
                            style={{ width: `${confidence}%` }}
                        />
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
