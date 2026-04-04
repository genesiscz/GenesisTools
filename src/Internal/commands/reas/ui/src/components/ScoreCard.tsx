import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Award, TrendingDown, TrendingUp } from "lucide-react";
import { GRADE_COLORS, getScoreCardModel } from "./analysis/display-model";

interface ScoreCardProps {
    data: DashboardExport;
}

export function ScoreCard({ data }: ScoreCardProps) {
    const { grade, glowClassName, score, recommendationLabel, recommendationClassName, reasoning, isPositive } =
        getScoreCardModel(data);

    return (
        <Card className="border-white/5">
            <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-mono">
                    <Award className="h-4 w-4 text-amber-400" />
                    Investment Score
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="flex items-center gap-6">
                    {/* Large grade */}
                    <div
                        className={cn(
                            "flex h-20 w-20 items-center justify-center rounded-xl border-2",
                            GRADE_COLORS[grade]
                        )}
                    >
                        <span className={cn("text-4xl font-black font-mono", glowClassName)}>{grade}</span>
                    </div>

                    <div className="flex-1 space-y-2">
                        {/* Score bar */}
                        <div className="flex items-baseline gap-2">
                            <span className="text-2xl font-bold font-mono text-foreground">{score}</span>
                            <span className="text-xs text-muted-foreground font-mono">/ 100</span>
                            {isPositive ? (
                                <TrendingUp className="h-4 w-4 text-green-400 ml-1" />
                            ) : (
                                <TrendingDown className="h-4 w-4 text-red-400 ml-1" />
                            )}
                        </div>

                        {/* Progress bar */}
                        <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                            <div
                                className={cn(
                                    "h-full rounded-full transition-all duration-500",
                                    score >= 65 ? "bg-green-500" : score >= 45 ? "bg-amber-500" : "bg-red-500"
                                )}
                                style={{ width: `${score}%` }}
                            />
                        </div>

                        {/* Recommendation badge */}
                        <Badge
                            className={cn(
                                "font-mono text-xs",
                                recommendationClassName.bg,
                                recommendationClassName.text
                            )}
                        >
                            {recommendationLabel}
                        </Badge>
                    </div>
                </div>

                {/* Reasoning */}
                <div className="mt-4 space-y-1">
                    {reasoning.map((r) => (
                        <div key={r} className="flex items-start gap-2 text-xs font-mono text-gray-400">
                            <span className="mt-1 h-1 w-1 rounded-full bg-amber-500/60 shrink-0" />
                            {r}
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
