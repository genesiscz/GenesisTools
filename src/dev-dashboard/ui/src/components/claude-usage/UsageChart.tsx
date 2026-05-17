import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface UsageChartProps {
    snapshots: { timestamp: string; utilization: number }[];
    hint?: string;
}

function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return timestamp;
    }

    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function UsageChart({ snapshots, hint }: UsageChartProps) {
    if (snapshots.length === 0) {
        return (
            <div className="dd-panel flex h-64 items-center justify-center p-4 text-center text-[var(--dd-text-muted)]">
                {hint ?? "No history yet."}
            </div>
        );
    }

    const data = snapshots.map((s) => ({ time: formatTime(s.timestamp), utilization: s.utilization }));

    return (
        <div className="dd-panel p-4">
            <h3 className="dd-accent-text mb-3 text-lg font-semibold">24h Utilization</h3>
            <ResponsiveContainer width="100%" height={256}>
                <LineChart data={data}>
                    <XAxis dataKey="time" stroke="var(--dd-text-muted)" fontSize={12} />
                    <YAxis domain={[0, 100]} stroke="var(--dd-text-muted)" fontSize={12} unit="%" />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: "var(--dd-bg-panel)",
                            border: "1px solid var(--dd-border)",
                            color: "var(--dd-text-primary)",
                        }}
                    />
                    <Line
                        type="monotone"
                        dataKey="utilization"
                        stroke="var(--dd-accent-from)"
                        strokeWidth={2}
                        dot={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
