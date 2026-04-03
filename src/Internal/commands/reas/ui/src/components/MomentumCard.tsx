import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Activity, ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useMemo } from "react";
import { getMomentumCardModel } from "./analysis/display-model";

interface MomentumCardProps {
    data: DashboardExport;
}

const DIRECTION_CONFIG: Record<string, { icon: typeof ArrowUp; color: string }> = {
    rising: { icon: ArrowUp, color: "text-green-400" },
    stable: { icon: ArrowRight, color: "text-amber-400" },
    declining: { icon: ArrowDown, color: "text-red-400" },
};

export function MomentumCard({ data }: MomentumCardProps) {
    const model = useMemo(() => getMomentumCardModel(data), [data]);

    const dirConfig = DIRECTION_CONFIG[model.direction];
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
                        <div className={cn("text-lg font-bold font-mono", model.directionClassName)}>
                            {model.directionLabel}
                        </div>
                        <div className="text-xs font-mono text-gray-500">{model.velocityPerPeriodLabel}</div>
                    </div>
                </div>

                {/* Momentum indicator */}
                <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-gray-500">Momentum</span>
                    <Badge className={cn("font-mono text-[10px]", model.momentumClassName)}>
                        {model.momentumLabel}
                    </Badge>
                </div>

                {/* Confidence */}
                <div className="space-y-1">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-gray-500">Confidence</span>
                        <span className="text-xs font-mono text-gray-400">{model.confidencePercent}%</span>
                    </div>
                    <div className="h-1 w-full rounded-full bg-white/5 overflow-hidden">
                        <div
                            className={cn("h-full rounded-full transition-all duration-500", model.confidenceClassName)}
                            style={{ width: `${model.confidencePercent}%` }}
                        />
                    </div>
                </div>

                <p className="text-xs font-mono text-gray-500">{model.interpretation}</p>
            </CardContent>
        </Card>
    );
}
