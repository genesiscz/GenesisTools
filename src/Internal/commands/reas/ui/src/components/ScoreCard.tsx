import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Award, TrendingDown, TrendingUp } from "lucide-react";

type Grade = "A" | "B" | "C" | "D" | "F";
type Recommendation = "strong-buy" | "buy" | "hold" | "avoid" | "strong-avoid";

interface ScoreResult {
    grade: Grade;
    score: number;
    recommendation: Recommendation;
    reasoning: string[];
}

const GRADE_COLORS: Record<Grade, string> = {
    A: "text-green-400 border-green-500/30 bg-green-500/10",
    B: "text-lime-400 border-lime-500/30 bg-lime-500/10",
    C: "text-amber-400 border-amber-500/30 bg-amber-500/10",
    D: "text-orange-400 border-orange-500/30 bg-orange-500/10",
    F: "text-red-400 border-red-500/30 bg-red-500/10",
};

const GRADE_GLOW: Record<Grade, string> = {
    A: "drop-shadow-[0_0_8px_rgba(74,222,128,0.4)]",
    B: "drop-shadow-[0_0_8px_rgba(163,230,53,0.4)]",
    C: "drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]",
    D: "drop-shadow-[0_0_8px_rgba(251,146,60,0.4)]",
    F: "drop-shadow-[0_0_8px_rgba(248,113,113,0.4)]",
};

const RECOMMENDATION_COLORS: Record<Recommendation, { bg: string; text: string }> = {
    "strong-buy": { bg: "bg-green-500/15 border-green-500/30", text: "text-green-400" },
    buy: { bg: "bg-lime-500/15 border-lime-500/30", text: "text-lime-400" },
    hold: { bg: "bg-amber-500/15 border-amber-500/30", text: "text-amber-400" },
    avoid: { bg: "bg-orange-500/15 border-orange-500/30", text: "text-orange-400" },
    "strong-avoid": { bg: "bg-red-500/15 border-red-500/30", text: "text-red-400" },
};

const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
    "strong-buy": "Strong Buy",
    buy: "Buy",
    hold: "Hold",
    avoid: "Avoid",
    "strong-avoid": "Strong Avoid",
};

export function computeScore(data: DashboardExport): ScoreResult {
    let score = 50;
    const reasoning: string[] = [];

    // Yield scoring
    const grossYield = data.analysis.yield.grossYield;

    if (grossYield >= 6) {
        score += 20;
        reasoning.push(`Strong gross yield: ${grossYield.toFixed(1)}%`);
    } else if (grossYield >= 4) {
        score += 10;
        reasoning.push(`Decent gross yield: ${grossYield.toFixed(1)}%`);
    } else if (grossYield < 3) {
        score -= 10;
        reasoning.push(`Low gross yield: ${grossYield.toFixed(1)}%`);
    }

    // Price vs market
    const targetPercentile = data.analysis.comparables.targetPercentile;

    if (targetPercentile < 30) {
        score += 15;
        reasoning.push(`Below market (${targetPercentile.toFixed(0)}th percentile)`);
    } else if (targetPercentile > 70) {
        score -= 15;
        reasoning.push(`Above market (${targetPercentile.toFixed(0)}th percentile)`);
    } else {
        reasoning.push(`Near market median (${targetPercentile.toFixed(0)}th percentile)`);
    }

    // Comparables count
    const count = data.analysis.comparables.count;

    if (count >= 20) {
        score += 5;
        reasoning.push(`Good data: ${count} comparables`);
    } else if (count < 5) {
        score -= 10;
        reasoning.push(`Low data: only ${count} comparables`);
    }

    // Discount
    const avgDiscount = data.analysis.discount.avgDiscount;

    if (avgDiscount > 10) {
        score += 5;
        reasoning.push(`Avg discount potential: ${avgDiscount.toFixed(1)}%`);
    }

    // Time on market
    const medianDays = data.analysis.timeOnMarket.median;

    if (medianDays < 30) {
        score += 5;
        reasoning.push(`Fast market (${medianDays.toFixed(0)}d median)`);
    } else if (medianDays > 120) {
        score -= 5;
        reasoning.push(`Slow market (${medianDays.toFixed(0)}d median)`);
    }

    // Clamp
    score = Math.max(0, Math.min(100, score));

    let grade: Grade;

    if (score >= 80) {
        grade = "A";
    } else if (score >= 65) {
        grade = "B";
    } else if (score >= 50) {
        grade = "C";
    } else if (score >= 35) {
        grade = "D";
    } else {
        grade = "F";
    }

    let recommendation: Recommendation;

    if (score >= 80) {
        recommendation = "strong-buy";
    } else if (score >= 65) {
        recommendation = "buy";
    } else if (score >= 45) {
        recommendation = "hold";
    } else if (score >= 30) {
        recommendation = "avoid";
    } else {
        recommendation = "strong-avoid";
    }

    return { grade, score, recommendation, reasoning };
}

interface ScoreCardProps {
    data: DashboardExport;
}

export function ScoreCard({ data }: ScoreCardProps) {
    const { grade, score, recommendation, reasoning } = computeScore(data);
    const recStyle = RECOMMENDATION_COLORS[recommendation];
    const isPositive = score >= 50;

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
                        <span className={cn("text-4xl font-black font-mono", GRADE_GLOW[grade])}>{grade}</span>
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
                        <Badge className={cn("font-mono text-xs", recStyle.bg, recStyle.text)}>
                            {RECOMMENDATION_LABELS[recommendation]}
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
