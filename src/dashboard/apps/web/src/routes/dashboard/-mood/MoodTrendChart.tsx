import { Card } from "@ui/components/card";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MoodTrendPoint } from "@/lib/mood/hooks/useMood";
import { ENERGY_COLOR, ENERGY_LABELS, formatDayShort, moodMeta } from "@/lib/mood/mood-scale";

interface MoodTrendChartProps {
    trend: MoodTrendPoint[];
}

interface TooltipPayloadItem {
    payload: MoodTrendPoint;
}

export function MoodTrendChart({ trend }: MoodTrendChartProps) {
    const hasData = trend.some((p) => p.mood !== null);

    return (
        <Card variant="wow-static" data-testid="mood-trend-chart" className="rounded-2xl p-5 gap-0">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h3 className="text-sm font-semibold text-foreground">Mood trend</h3>
                    <p className="text-xs text-muted-foreground">Last 30 days</p>
                </div>
                <div className="flex items-center gap-4">
                    <Legend color="var(--primary)" label="Mood" />
                    <Legend color={ENERGY_COLOR} label="Energy" />
                </div>
            </div>

            {hasData ? (
                <div className="h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={trend} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                            <defs>
                                <linearGradient id="moodGradient" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.35} />
                                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                            <XAxis
                                dataKey="label"
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                                interval={4}
                                dy={8}
                            />
                            <YAxis
                                domain={[1, 5]}
                                ticks={[1, 2, 3, 4, 5]}
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                                width={28}
                            />
                            <Tooltip content={<MoodTooltip />} cursor={{ stroke: "var(--border)" }} />
                            <Area
                                type="monotone"
                                dataKey="mood"
                                stroke="var(--primary)"
                                strokeWidth={2.5}
                                fill="url(#moodGradient)"
                                connectNulls
                                dot={<MoodDot />}
                                activeDot={false}
                            />
                            <Line
                                type="monotone"
                                dataKey="energy"
                                stroke={ENERGY_COLOR}
                                strokeWidth={2}
                                strokeDasharray="4 3"
                                connectNulls
                                dot={false}
                                activeDot={{ r: 4, fill: ENERGY_COLOR }}
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            ) : (
                <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                    Log a few check-ins to see your trend
                </div>
            )}
        </Card>
    );
}

function Legend({ color, label }: { color: string; label: string }) {
    return (
        <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-xs text-muted-foreground">{label}</span>
        </div>
    );
}

interface DotProps {
    cx?: number;
    cy?: number;
    payload?: MoodTrendPoint;
}

function MoodDot({ cx, cy, payload }: DotProps) {
    if (cx === undefined || cy === undefined || !payload || payload.mood === null) {
        return null;
    }

    const color = moodMeta(payload.mood).color;
    return <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--background)" strokeWidth={1.5} />;
}

function MoodTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
    if (!active || !payload || !payload.length) {
        return null;
    }

    const point = payload[0].payload;
    if (point.mood === null) {
        return null;
    }

    const meta = moodMeta(point.mood);
    const energy = point.energy ?? 0;

    return (
        <div className="rounded-lg border border-border bg-popover/95 p-3 shadow-lg backdrop-blur-sm">
            <p className="mb-2 text-xs font-medium text-foreground">{formatDayShort(point.day)}</p>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="text-base">{meta.emoji}</span>
                <span className={meta.textClass}>{meta.label}</span>
            </p>
            {energy > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                    Energy: <span style={{ color: ENERGY_COLOR }}>{ENERGY_LABELS[energy as 1 | 2 | 3 | 4 | 5]}</span>
                </p>
            )}
        </div>
    );
}
