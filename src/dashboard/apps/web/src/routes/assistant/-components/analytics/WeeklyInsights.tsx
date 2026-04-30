import { AlertTriangle, Clock, Terminal, TrendingDown, TrendingUp, Zap } from "lucide-react";
import type { WeeklyReview } from "@/lib/assistant/types";
import { cn } from "@/lib/utils";

interface WeeklyInsightsProps {
    review: WeeklyReview | null;
    comparison: {
        tasksChange: number;
        tasksChangePercent: number;
        direction: "up" | "down" | "same";
    } | null;
    loading?: boolean;
}

interface Insight {
    icon: React.ComponentType<{ className?: string }>;
    iconColor: string;
    text: string;
    type: "positive" | "neutral" | "warning";
}

/**
 * Terminal-styled insights panel with AI-like recommendations
 */
export function WeeklyInsights({ review, comparison, loading }: WeeklyInsightsProps) {
    if (loading) {
        return <InsightsSkeleton />;
    }

    // Generate insights based on review data
    const insights = generateInsights(review, comparison);

    return (
        <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
            {/* Corner decorations */}
            <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-purple-500/20 rounded-tl" />
            <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-purple-500/20 rounded-tr" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-purple-500/20 rounded-bl" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-purple-500/20 rounded-br" />

            {/* Header */}
            <div className="flex items-center gap-2 mb-4">
                <div className="p-1.5 rounded bg-purple-500/10">
                    <Terminal className="h-4 w-4 text-purple-400" />
                </div>
                <div>
                    <h3 className="text-sm font-semibold">Weekly Insights</h3>
                    <p className="text-[10px] text-muted-foreground font-mono">$ productivity-ai --analyze</p>
                </div>
            </div>

            {/* Insights list */}
            <div className="space-y-3">
                {insights.length === 0 ? (
                    <div className="text-sm text-muted-foreground font-mono py-4 text-center">
                        {">"} Complete more tasks to unlock insights
                    </div>
                ) : (
                    insights.map((insight, index) => <InsightRow key={index} insight={insight} index={index} />)
                )}
            </div>

            {/* Terminal cursor */}
            <div className="mt-4 pt-3 border-t border-white/5">
                <span className="text-xs text-muted-foreground font-mono">
                    {">"} <span className="text-purple-400">_</span>
                    <span className="animate-pulse">|</span>
                </span>
            </div>
        </div>
    );
}

function InsightRow({ insight, index }: { insight: Insight; index: number }) {
    const Icon = insight.icon;

    return (
        <div
            className={cn(
                "flex items-start gap-3 p-2 rounded-lg transition-colors",
                insight.type === "positive" && "bg-emerald-500/5 hover:bg-emerald-500/10",
                insight.type === "warning" && "bg-amber-500/5 hover:bg-amber-500/10",
                insight.type === "neutral" && "bg-white/5 hover:bg-white/10"
            )}
            style={{
                animationDelay: `${index * 100}ms`,
            }}
        >
            <Icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", insight.iconColor)} />
            <p className="text-sm text-foreground/90 font-mono leading-relaxed">{insight.text}</p>
        </div>
    );
}

function generateInsights(
    review: WeeklyReview | null,
    comparison: {
        tasksChange: number;
        tasksChangePercent: number;
        direction: "up" | "down" | "same";
    } | null
): Insight[] {
    const insights: Insight[] = [];

    if (!review) {
        return insights;
    }

    // Week-over-week comparison
    if (comparison) {
        if (comparison.direction === "up" && comparison.tasksChangePercent > 10) {
            insights.push({
                icon: TrendingUp,
                iconColor: "text-emerald-400",
                text: `You completed ${comparison.tasksChangePercent}% more tasks this week! Great momentum.`,
                type: "positive",
            });
        } else if (comparison.direction === "down" && comparison.tasksChangePercent > 20) {
            insights.push({
                icon: TrendingDown,
                iconColor: "text-amber-400",
                text: `Productivity dipped ${Math.abs(comparison.tasksChangePercent)}% from last week. Consider breaking tasks into smaller chunks.`,
                type: "warning",
            });
        }
    }

    // Peak focus time insight
    if (review.peakFocusTime) {
        insights.push({
            icon: Zap,
            iconColor: "text-cyan-400",
            text: `Peak focus: ${review.peakFocusTime}. Schedule deep work during this time.`,
            type: "positive",
        });
    }

    // Low energy time insight
    if (review.lowEnergyTime) {
        insights.push({
            icon: Clock,
            iconColor: "text-amber-400",
            text: `Low energy: ${review.lowEnergyTime}. Reserve this for lighter tasks.`,
            type: "neutral",
        });
    }

    // Energy by day pattern
    const energyByDay = review.energyByDay ?? {};
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayEntries = Object.entries(energyByDay).filter(([_, v]) => v > 0);

    if (dayEntries.length >= 3) {
        const weakestDay = dayEntries.reduce(
            (min, [day, val]) => (val < (energyByDay[min] ?? 5) ? day : min),
            dayEntries[0][0]
        );

        const weakestDayEnergy = energyByDay[weakestDay] ?? 0;

        if (weakestDayEnergy < 3) {
            insights.push({
                icon: AlertTriangle,
                iconColor: "text-rose-400",
                text: `${dayNames[parseInt(weakestDay, 10)]} is your weak spot. Try lighter tasks or take a break.`,
                type: "warning",
            });
        }
    }

    // Deep focus percentage
    const deepFocusPercent = review.totalMinutes > 0 ? (review.deepFocusMinutes / review.totalMinutes) * 100 : 0;

    if (deepFocusPercent >= 50) {
        insights.push({
            icon: Zap,
            iconColor: "text-emerald-400",
            text: `${Math.round(deepFocusPercent)}% of your time was deep work. Excellent focus!`,
            type: "positive",
        });
    } else if (deepFocusPercent < 30 && review.totalMinutes > 0) {
        insights.push({
            icon: AlertTriangle,
            iconColor: "text-amber-400",
            text: `Only ${Math.round(deepFocusPercent)}% deep work. Try time-blocking for focused sessions.`,
            type: "warning",
        });
    }

    // Deadline performance
    if (review.deadlinesTotal > 0) {
        const hitRate = (review.deadlinesHit / review.deadlinesTotal) * 100;

        if (hitRate === 100) {
            insights.push({
                icon: TrendingUp,
                iconColor: "text-emerald-400",
                text: `Perfect deadline record! All ${review.deadlinesTotal} deadlines met on time.`,
                type: "positive",
            });
        } else if (hitRate < 70) {
            insights.push({
                icon: AlertTriangle,
                iconColor: "text-rose-400",
                text: `${Math.round(100 - hitRate)}% of deadlines missed. Try estimating with a 1.5x buffer.`,
                type: "warning",
            });
        }
    }

    // Add custom insights from the review
    if (review.insights && review.insights.length > 0) {
        review.insights.slice(0, 2).forEach((insight) => {
            insights.push({
                icon: Zap,
                iconColor: "text-purple-400",
                text: insight,
                type: "neutral",
            });
        });
    }

    // Recommendations
    if (review.recommendations && review.recommendations.length > 0) {
        review.recommendations.slice(0, 1).forEach((rec) => {
            insights.push({
                icon: Terminal,
                iconColor: "text-purple-400",
                text: rec,
                type: "neutral",
            });
        });
    }

    return insights.slice(0, 5); // Limit to 5 insights
}

function InsightsSkeleton() {
    return (
        <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4">
            <div className="flex items-center gap-2 mb-4">
                <div className="h-7 w-7 rounded bg-white/5 animate-pulse" />
                <div>
                    <div className="h-4 w-28 bg-white/5 rounded animate-pulse mb-1" />
                    <div className="h-3 w-36 bg-white/5 rounded animate-pulse" />
                </div>
            </div>
            <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-start gap-3 p-2">
                        <div className="h-4 w-4 rounded bg-white/5 animate-pulse" />
                        <div className="flex-1">
                            <div className="h-4 w-full bg-white/5 rounded animate-pulse mb-1" />
                            <div className="h-4 w-2/3 bg-white/5 rounded animate-pulse" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
