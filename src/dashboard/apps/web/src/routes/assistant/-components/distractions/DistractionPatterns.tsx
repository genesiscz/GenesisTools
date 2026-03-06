import { AlertTriangle, Calendar, Clock } from "lucide-react";
import { useMemo } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FeatureCard, FeatureCardContent, FeatureCardHeader } from "@/components/ui/feature-card";
import type { Distraction } from "@/lib/assistant/types";

interface DistractionPatternsProps {
    distractions: Distraction[];
    loading?: boolean;
    className?: string;
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourRanges = [
    { start: 6, end: 9, label: "6-9am" },
    { start: 9, end: 12, label: "9am-12pm" },
    { start: 12, end: 14, label: "12-2pm" },
    { start: 14, end: 17, label: "2-5pm" },
    { start: 17, end: 20, label: "5-8pm" },
];

/**
 * Custom tooltip for bar chart
 */
function CustomTooltip({
    active,
    payload,
    label,
}: {
    active?: boolean;
    payload?: Array<{ value: number }>;
    label?: string;
}) {
    if (!active || !payload?.[0]) {
        return null;
    }

    return (
        <div className="bg-[#0a0a14]/95 border border-white/10 rounded-lg p-3 shadow-xl">
            <p className="font-medium mb-1">{label}</p>
            <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-purple-400">{payload[0].value}</span> interruptions
            </p>
        </div>
    );
}

/**
 * DistractionPatterns - Analysis of distraction timing patterns
 *
 * Features:
 * - Bar chart showing distractions by day of week
 * - Peak distraction time detection
 * - Pattern identification ("Tuesday 2-4pm is chaos window")
 */
export function DistractionPatterns({ distractions, loading = false, className }: DistractionPatternsProps) {
    // Analyze patterns
    const analysis = useMemo(() => {
        if (distractions.length === 0) {
            return {
                byDay: dayNames.map((day) => ({ day, count: 0 })),
                peakDay: null,
                peakTimeRange: null,
                chaosWindows: [],
                byHourAndDay: {} as Record<string, Record<number, number>>,
            };
        }

        // Count by day of week
        const dayCounts: Record<number, number> = {};
        // Count by hour and day
        const hourDayCounts: Record<string, Record<number, number>> = {};

        for (const d of distractions) {
            const date = new Date(d.timestamp);
            const dayOfWeek = date.getDay();
            const hour = date.getHours();
            const dayName = dayNames[dayOfWeek];

            dayCounts[dayOfWeek] = (dayCounts[dayOfWeek] || 0) + 1;

            if (!hourDayCounts[dayName]) {
                hourDayCounts[dayName] = {};
            }
            hourDayCounts[dayName][hour] = (hourDayCounts[dayName][hour] || 0) + 1;
        }

        // Transform to chart data
        const byDay = dayNames.map((day, index) => ({
            day,
            count: dayCounts[index] || 0,
        }));

        // Find peak day
        let peakDayIndex = 0;
        let peakDayCount = 0;
        for (const [dayIndex, count] of Object.entries(dayCounts)) {
            if (count > peakDayCount) {
                peakDayCount = count;
                peakDayIndex = Number.parseInt(dayIndex, 10);
            }
        }
        const peakDay = peakDayCount > 0 ? dayNames[peakDayIndex] : null;

        // Find chaos windows (time ranges with high distraction counts)
        const chaosWindows: Array<{ day: string; timeRange: string; count: number }> = [];
        for (const [day, hours] of Object.entries(hourDayCounts)) {
            for (const range of hourRanges) {
                let rangeCount = 0;
                for (let h = range.start; h < range.end; h++) {
                    rangeCount += hours[h] || 0;
                }
                if (rangeCount >= 3) {
                    // Threshold for "chaos window"
                    chaosWindows.push({ day, timeRange: range.label, count: rangeCount });
                }
            }
        }
        chaosWindows.sort((a, b) => b.count - a.count);

        // Find peak time range overall
        const timeRangeCounts: Record<string, number> = {};
        for (const d of distractions) {
            const hour = new Date(d.timestamp).getHours();
            for (const range of hourRanges) {
                if (hour >= range.start && hour < range.end) {
                    timeRangeCounts[range.label] = (timeRangeCounts[range.label] || 0) + 1;
                    break;
                }
            }
        }
        let peakTimeRange: string | null = null;
        let peakTimeCount = 0;
        for (const [range, count] of Object.entries(timeRangeCounts)) {
            if (count > peakTimeCount) {
                peakTimeCount = count;
                peakTimeRange = range;
            }
        }

        return {
            byDay,
            peakDay,
            peakTimeRange,
            chaosWindows: chaosWindows.slice(0, 3), // Top 3
            byHourAndDay: hourDayCounts,
        };
    }, [distractions]);

    // Calculate bar colors based on count (gradient from purple to red)
    function getBarColor(count: number, maxCount: number): string {
        if (maxCount === 0) {
            return "#a855f7"; // purple
        }
        const intensity = count / maxCount;
        if (intensity > 0.7) {
            return "#ef4444"; // red
        }
        if (intensity > 0.4) {
            return "#f97316"; // orange
        }
        return "#a855f7"; // purple
    }

    const maxCount = Math.max(...analysis.byDay.map((d) => d.count), 1);

    if (loading) {
        return (
            <FeatureCard color="purple" className={className}>
                <FeatureCardHeader>
                    <h3 className="text-lg font-semibold">Distraction Patterns</h3>
                </FeatureCardHeader>
                <FeatureCardContent>
                    <div className="h-64 flex items-center justify-center">
                        <div className="animate-pulse text-muted-foreground">Analyzing patterns...</div>
                    </div>
                </FeatureCardContent>
            </FeatureCard>
        );
    }

    const hasData = distractions.length > 0;

    return (
        <FeatureCard color="purple" className={className}>
            <FeatureCardHeader>
                <h3 className="text-lg font-semibold">Distraction Patterns</h3>
                <p className="text-sm text-muted-foreground">When do interruptions happen most?</p>
            </FeatureCardHeader>

            <FeatureCardContent>
                {!hasData ? (
                    <div className="h-64 flex flex-col items-center justify-center text-muted-foreground">
                        <Calendar className="h-12 w-12 mb-4 opacity-50" />
                        <p>Not enough data yet</p>
                        <p className="text-sm mt-1">Log more distractions to see patterns</p>
                    </div>
                ) : (
                    <>
                        {/* Bar chart by day of week */}
                        <div className="h-48 mb-6">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={analysis.byDay} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                    <XAxis
                                        dataKey="day"
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{ fill: "#9ca3af", fontSize: 12 }}
                                    />
                                    <YAxis
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{ fill: "#9ca3af", fontSize: 12 }}
                                        allowDecimals={false}
                                    />
                                    <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
                                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                                        {analysis.byDay.map((entry) => (
                                            <Cell
                                                key={entry.day}
                                                fill={getBarColor(entry.count, maxCount)}
                                                style={{
                                                    filter:
                                                        entry.count > maxCount * 0.5
                                                            ? "drop-shadow(0 0 8px rgba(239, 68, 68, 0.4))"
                                                            : "drop-shadow(0 0 4px rgba(168, 85, 247, 0.3))",
                                                }}
                                            />
                                        ))}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>

                        {/* Pattern insights */}
                        <div className="space-y-3">
                            {/* Peak day */}
                            {analysis.peakDay && (
                                <div className="flex items-start gap-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
                                    <Calendar className="h-5 w-5 text-purple-400 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium text-purple-300">
                                            {analysis.peakDay} is your busiest day
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            Consider protecting focus blocks on this day
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Peak time */}
                            {analysis.peakTimeRange && (
                                <div className="flex items-start gap-3 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
                                    <Clock className="h-5 w-5 text-orange-400 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium text-orange-300">
                                            {analysis.peakTimeRange} is peak distraction time
                                        </p>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            Avoid scheduling deep work during this window
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Chaos windows */}
                            {analysis.chaosWindows.length > 0 && (
                                <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                                    <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium text-red-300">Chaos Window Detected</p>
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            {analysis.chaosWindows.map((window, i) => (
                                                <span
                                                    key={i}
                                                    className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-300 border border-red-500/30"
                                                >
                                                    {window.day} {window.timeRange}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </FeatureCardContent>
        </FeatureCard>
    );
}
