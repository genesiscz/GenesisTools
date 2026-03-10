import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { WeeklyReview } from "@/lib/assistant/types";

interface EnergyByDayProps {
    review: WeeklyReview | null;
    loading?: boolean;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getBarColor(value: number): string {
    if (value >= 4) {
        return "#10b981"; // emerald
    }
    if (value >= 3) {
        return "#f59e0b"; // amber
    }
    if (value >= 2) {
        return "#f97316"; // orange
    }
    return "#f43f5e"; // rose
}

/**
 * Bar chart showing average energy by day of week
 */
export function EnergyByDay({ review, loading }: EnergyByDayProps) {
    if (loading) {
        return <ChartSkeleton />;
    }

    // Transform energyByDay into chart data
    const energyByDay = review?.energyByDay ?? {};
    const chartData = DAYS.map((day, index) => ({
        name: day,
        energy: energyByDay[index.toString()] ?? 0,
        fullDay: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][index],
    }));

    // Check if we have any data
    const hasData = chartData.some((d) => d.energy > 0);

    // Find weak spot (lowest non-zero day)
    const nonZeroDays = chartData.filter((d) => d.energy > 0);
    const weakSpot = nonZeroDays.length > 0 ? nonZeroDays.reduce((min, d) => (d.energy < min.energy ? d : min)) : null;
    const strongSpot =
        nonZeroDays.length > 0 ? nonZeroDays.reduce((max, d) => (d.energy > max.energy ? d : max)) : null;

    return (
        <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4 h-full">
            {/* Corner decorations */}
            <div className="absolute top-0 left-0 w-4 h-4 border-l border-t border-emerald-500/20 rounded-tl" />
            <div className="absolute top-0 right-0 w-4 h-4 border-r border-t border-emerald-500/20 rounded-tr" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-l border-b border-emerald-500/20 rounded-bl" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-r border-b border-emerald-500/20 rounded-br" />

            <div className="flex items-start justify-between mb-2">
                <div>
                    <h3 className="text-sm font-semibold">Energy by Day</h3>
                    <p className="text-xs text-muted-foreground">Average focus quality</p>
                </div>
                {strongSpot && strongSpot.energy >= 3 && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        Peak: {strongSpot.name}
                    </span>
                )}
            </div>

            {!hasData ? (
                <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">
                    Log energy snapshots to see patterns
                </div>
            ) : (
                <>
                    <div className="h-[160px] mt-2">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                                <XAxis
                                    dataKey="name"
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
                                    dy={10}
                                />
                                <YAxis
                                    domain={[0, 5]}
                                    axisLine={false}
                                    tickLine={false}
                                    tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
                                    width={30}
                                    ticks={[1, 2, 3, 4, 5]}
                                />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey="energy" radius={[4, 4, 0, 0]} maxBarSize={40}>
                                    {chartData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={getBarColor(entry.energy)} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Insight */}
                    {weakSpot && weakSpot.energy < 3 && (
                        <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-white/5">
                            <span className="text-rose-400">{weakSpot.fullDay}</span> tends to be your low-energy day.
                        </p>
                    )}
                </>
            )}
        </div>
    );
}

interface TooltipPayload {
    name: string;
    energy: number;
    fullDay: string;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TooltipPayload }> }) {
    if (!active || !payload || !payload.length) {
        return null;
    }

    const data = payload[0].payload;
    const qualityLabel = getQualityLabel(data.energy);
    const color = getBarColor(data.energy);

    return (
        <div className="bg-[#0a0a14]/95 backdrop-blur-sm border border-emerald-500/20 rounded-lg p-3 shadow-lg">
            <p className="text-xs font-medium text-emerald-400 mb-1">{data.fullDay}</p>
            <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-xs text-muted-foreground">
                    <span className="text-white font-medium">{data.energy.toFixed(1)}</span> / 5 ({qualityLabel})
                </span>
            </div>
        </div>
    );
}

function getQualityLabel(value: number): string {
    if (value >= 4.5) {
        return "Excellent";
    }
    if (value >= 3.5) {
        return "Good";
    }
    if (value >= 2.5) {
        return "Average";
    }
    if (value >= 1.5) {
        return "Poor";
    }
    return "Very Poor";
}

function ChartSkeleton() {
    return (
        <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5 p-4 h-full">
            <div className="mb-4">
                <div className="h-4 w-28 bg-white/5 rounded animate-pulse mb-1" />
                <div className="h-3 w-32 bg-white/5 rounded animate-pulse" />
            </div>
            <div className="h-[180px] flex items-end gap-2 px-4">
                {[40, 70, 55, 30, 80, 65, 45].map((height, i) => (
                    <div
                        key={i}
                        className="flex-1 bg-white/5 rounded-t animate-pulse"
                        style={{ height: `${height}%` }}
                    />
                ))}
            </div>
        </div>
    );
}
