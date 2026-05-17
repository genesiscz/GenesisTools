import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface PulseGraphProps {
    title: string;
    points: { ts: string; value: number }[];
    unit?: string;
}

export function PulseGraph({ title, points, unit }: PulseGraphProps) {
    const gradientId = `grad-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const data = points.map((p) => ({
        time: new Date(p.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        value: Math.round(p.value * 10) / 10,
    }));

    return (
        <div className="dd-panel p-4">
            <h3 className="dd-accent-text mb-3 text-sm font-bold tracking-widest">{title}</h3>
            <div style={{ width: "100%", height: 180 }}>
                <ResponsiveContainer>
                    <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <defs>
                            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#34d399" stopOpacity={0.4} />
                                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <XAxis
                            dataKey="time"
                            tick={{ fontSize: 10, fill: "var(--dd-text-muted)" }}
                            stroke="var(--dd-border)"
                        />
                        <YAxis
                            tick={{ fontSize: 10, fill: "var(--dd-text-muted)" }}
                            stroke="var(--dd-border)"
                            domain={[0, 100]}
                            tickFormatter={(v: number) => `${v}${unit ?? ""}`}
                        />
                        <Tooltip
                            contentStyle={{
                                background: "var(--dd-bg-panel)",
                                border: "1px solid var(--dd-border)",
                                fontSize: 12,
                            }}
                            formatter={(v) => [`${Number(v)}${unit ?? ""}`, title]}
                        />
                        <Area
                            type="monotone"
                            dataKey="value"
                            stroke="#34d399"
                            strokeWidth={2}
                            fill={`url(#${gradientId})`}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
