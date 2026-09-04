import type { AccountRef, SpendGrain, SpendSeriesPoint } from "@app/dev-dashboard/contract/ai-accounts";
import { ChartBox } from "@ui/components/chart-box";
import { Area, AreaChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";
import { ACCOUNT_PALETTE, hashString } from "@/lib/account-color";
import { bucketLabel, buildSpendChartData, formatUsd, type SpendChartMode, TOTAL_KEY } from "@/lib/spend-chart-data";
import { ChartLegend } from "./ChartLegend";

interface SpendChartProps {
    points: SpendSeriesPoint[];
    accounts: AccountRef[];
    /** Account id to colour, shared with the chips. */
    colors: Record<string, string>;
    mode: SpendChartMode;
    hiddenAccountIds: ReadonlySet<string>;
    rangeStartMs: number;
    rangeEndMs: number;
    grain: SpendGrain;
    height?: number;
}

const TICK_COUNT = 6;

const TOOLTIP_STYLE = {
    backgroundColor: "var(--dd-bg-panel)",
    border: "1px solid var(--dd-border)",
    borderRadius: 8,
    color: "var(--dd-text-primary)",
    fontSize: 12,
} as const;

/** recharts stacked areas, per-account lines, one total line, or per-model stacks. */
export function SpendChart({
    points,
    accounts,
    colors,
    mode,
    hiddenAccountIds,
    rangeStartMs,
    rangeEndMs,
    grain,
    height = 240,
}: SpendChartProps) {
    const { rows, keys } = buildSpendChartData(points, { mode, hiddenAccountIds });
    const names = new Map(
        accounts.map((a) => [a.accountId, a.label ? `${a.accountName} (${a.label})` : a.accountName])
    );
    const ticks = Array.from(
        { length: TICK_COUNT },
        (_, i) => rangeStartMs + ((rangeEndMs - rangeStartMs) * i) / (TICK_COUNT - 1)
    );
    // One formatter for the axis and the tooltip, in the same local zone the
    // bucket keys were parsed in, so a point cannot be labelled two ways.
    const format = bucketLabel(grain, (rangeEndMs - rangeStartMs) / 60_000);

    const nameOf = (key: string): string => {
        if (key === TOTAL_KEY) {
            return "total";
        }

        return names.get(key) ?? key;
    };
    const colorOf = (key: string): string => {
        if (key === TOTAL_KEY) {
            return "var(--dd-accent-from)";
        }

        return colors[key] ?? ACCOUNT_PALETTE[hashString(key) % ACCOUNT_PALETTE.length];
    };

    if (rows.length === 0) {
        return (
            <div className="flex h-40 items-center justify-center text-sm text-[var(--dd-text-muted)]">
                No spend in this window.
            </div>
        );
    }

    const axes = (
        <>
            <CartesianGrid stroke="var(--dd-border)" strokeDasharray="3 3" />
            <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={[rangeStartMs, rangeEndMs]}
                ticks={ticks}
                allowDataOverflow={false}
                tickFormatter={format}
                stroke="var(--dd-text-muted)"
                fontSize={11}
                minTickGap={28}
            />
            <YAxis stroke="var(--dd-text-muted)" fontSize={11} width={52} tickFormatter={(v: number) => formatUsd(v)} />
            <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelFormatter={(ms) => `${format(ms as number)} (${grain})`}
                formatter={(value, name) => [formatUsd(Number(value)), String(name)]}
            />
        </>
    );

    const stacked = mode === "stacked" || mode === "byModel";
    const legend = keys.map((key) => ({ id: key, label: nameOf(key), color: colorOf(key) }));

    return (
        <>
            <ChartBox height={height}>
                {(size) =>
                    stacked ? (
                        <AreaChart width={size.width} height={size.height} data={rows}>
                            {axes}
                            {keys.map((key) => (
                                <Area
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    name={nameOf(key)}
                                    stackId="cost"
                                    stroke={colorOf(key)}
                                    fill={colorOf(key)}
                                    fillOpacity={0.28}
                                    strokeWidth={1.5}
                                    isAnimationActive={false}
                                />
                            ))}
                        </AreaChart>
                    ) : (
                        <LineChart width={size.width} height={size.height} data={rows}>
                            {axes}
                            {keys.map((key) => (
                                <Line
                                    key={key}
                                    type="monotone"
                                    dataKey={key}
                                    name={nameOf(key)}
                                    stroke={colorOf(key)}
                                    strokeWidth={key === TOTAL_KEY ? 2.5 : 2}
                                    dot={false}
                                    connectNulls
                                    isAnimationActive={false}
                                />
                            ))}
                        </LineChart>
                    )
                }
            </ChartBox>
            <ChartLegend items={legend} variant={stacked ? "area" : "line"} />
        </>
    );
}
