import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { ChartContainer, ChartTooltipContent, chartAxisProps, chartGridProps } from "@ui/graphs";
import { useMemo } from "react";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    ComposedChart,
    LabelList,
    Line,
    LineChart,
    ReferenceDot,
    ReferenceLine,
    Scatter,
    ScatterChart,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { formatCurrency, formatInteger, formatPercent, formatSignedPercent, getTargetPricePerM2 } from "./utils";

const HISTOGRAM_COLORS = ["#f59e0b", "#14b8a6", "#38bdf8", "#818cf8", "#c084fc", "#f472b6"];

interface DistributionHistogramProps {
    title: string;
    description: string;
    data: Array<{ range: string; count: number }>;
    countLabel: string;
}

export function DistributionHistogram({ title, description, data, countLabel }: DistributionHistogramProps) {
    return (
        <ChartContainer title={title} description={description} height={280} className="border-white/5 bg-white/[0.02]">
            <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} dataKey="range" interval={0} angle={-25} textAnchor="end" height={56} />
                <YAxis {...chartAxisProps} allowDecimals={false} />
                <Tooltip content={<HistogramTooltip countLabel={countLabel} />} />
                <Bar dataKey="count" radius={[8, 8, 0, 0]}>
                    {data.map((entry, index) => (
                        <Cell
                            key={`${entry.range}-${entry.count}`}
                            fill={HISTOGRAM_COLORS[index % HISTOGRAM_COLORS.length]}
                        />
                    ))}
                    <LabelList dataKey="count" position="top" className="fill-slate-400 font-mono text-[10px]" />
                </Bar>
            </BarChart>
        </ChartContainer>
    );
}

interface TrendChartCardProps {
    data: DashboardExport;
}

export function TrendChartCard({ data }: TrendChartCardProps) {
    const chartData = useMemo(
        () =>
            data.analysis.trends.map((item) => ({
                period: item.period,
                medianPricePerM2: Math.round(item.medianPricePerM2),
                qoqChange: item.qoqChange,
                count: item.count,
                provenance: item.provenance,
            })),
        [data]
    );

    return (
        <ChartContainer
            title="Median price trajectory"
            description="Quarter-over-quarter pricing signal for sold comparables in the selected district."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <LineChart data={chartData} margin={{ top: 10, right: 20, left: 12, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} dataKey="period" />
                <YAxis
                    {...chartAxisProps}
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                    width={56}
                />
                <Tooltip content={<TrendTooltip />} />
                <Line
                    type="monotone"
                    dataKey="medianPricePerM2"
                    name="Median price / m²"
                    stroke="#38bdf8"
                    strokeWidth={3}
                    dot={{ r: 4, fill: "#38bdf8", stroke: "#0f172a", strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: "#f59e0b" }}
                />
                <Line type="monotone" dataKey="qoqChange" name="QoQ" stroke="#a78bfa" strokeWidth={2} dot={false} />
            </LineChart>
        </ChartContainer>
    );
}

interface ComparablesScatterChartProps {
    data: DashboardExport;
}

export function ComparablesScatterChart({ data }: ComparablesScatterChartProps) {
    const targetArea = data.meta.target.area;
    const targetPricePerM2 = getTargetPricePerM2(data);
    const chartData = data.analysis.scatter.filter((item) => item.area > 0 && item.pricePerM2 > 0);

    return (
        <ChartContainer
            title="Comparable sales scatter"
            description="Area on the x-axis, realized price per square meter on the y-axis."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <ScatterChart margin={{ top: 10, right: 24, left: 12, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} type="number" dataKey="area" name="Area" unit=" m²" />
                <YAxis
                    {...chartAxisProps}
                    type="number"
                    dataKey="pricePerM2"
                    name="CZK / m²"
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                    width={64}
                />
                <Tooltip
                    content={<ScatterTooltip />}
                    cursor={{ strokeDasharray: "4 4", stroke: "rgba(255,255,255,0.18)" }}
                />
                <Scatter data={chartData} fill="#22d3ee">
                    {chartData.map((item, index) => (
                        <Cell
                            key={`${item.address}-${item.area}-${item.pricePerM2}`}
                            fill={HISTOGRAM_COLORS[index % HISTOGRAM_COLORS.length]}
                        />
                    ))}
                </Scatter>
                <ReferenceDot
                    x={targetArea}
                    y={targetPricePerM2}
                    r={7}
                    fill="#f59e0b"
                    stroke="#fef3c7"
                    strokeWidth={2}
                    label={{ value: "Target", position: "top", fill: "#fcd34d", fontSize: 11 }}
                />
            </ScatterChart>
        </ChartContainer>
    );
}

function ScatterTooltip({
    active,
    payload,
}: {
    active?: boolean;
    payload?: Array<{ payload?: DashboardExport["analysis"]["scatter"][number] }>;
}) {
    if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
        return null;
    }

    const item = payload[0].payload;

    return (
        <div className="min-w-56 rounded-xl border border-white/10 bg-slate-950/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-sm">
            <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-slate-300">{item.address}</div>
            <div className="space-y-1 font-mono text-slate-200">
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Area</span>
                    <span>{formatInteger(item.area)} m²</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Price / m²</span>
                    <span>{formatCurrency(item.pricePerM2)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Disposition</span>
                    <span>{item.disposition || "Unknown"}</span>
                </div>
                {item.sourceContract ? (
                    <div className="flex items-center justify-between gap-4">
                        <span className="text-slate-400">Contract</span>
                        <span>{item.sourceContract}</span>
                    </div>
                ) : null}
                {item.provenance?.providerDetails[0] ? (
                    <div className="flex items-center justify-between gap-4">
                        <span className="text-slate-400">Fetched</span>
                        <span>{formatTooltipDate(item.provenance.providerDetails[0].fetchedAt)}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function TrendTooltip({
    active,
    payload,
}: {
    active?: boolean;
    payload?: Array<{
        payload?: DashboardExport["analysis"]["trends"][number];
        name?: string;
        value?: number;
    }>;
}) {
    if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
        return null;
    }

    const item = payload[0].payload;

    return (
        <div className="min-w-56 rounded-xl border border-white/10 bg-slate-950/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-sm">
            <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-slate-300">{item.period}</div>
            <div className="space-y-1 font-mono text-slate-200">
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Median price / m²</span>
                    <span>{formatCurrency(item.medianPricePerM2)}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Comparables</span>
                    <span>{item.count}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">QoQ</span>
                    <span>{item.qoqChange != null ? formatSignedPercent(item.qoqChange) : "-"}</span>
                </div>
            </div>
            {item.provenance?.note ? (
                <div className="mt-2 text-[11px] font-mono leading-5 text-slate-400">{item.provenance.note}</div>
            ) : null}
        </div>
    );
}

interface ActiveSalesChartProps {
    data: DashboardExport;
    listings?: DashboardExport["listings"]["activeSales"];
}

export function ActiveSalesChart({ data, listings }: ActiveSalesChartProps) {
    const chartData = (listings ?? data.listings.activeSales)
        .filter((listing) => (listing.area ?? 0) > 0 && (listing.pricePerM2 ?? 0) > 0)
        .map((listing) => ({
            area: listing.area ?? 0,
            pricePerM2: listing.pricePerM2 ?? 0,
            address: listing.address,
            sourceContract: listing.sourceContract,
            provenance: listing.provenance,
        }));

    if (chartData.length === 0) {
        return null;
    }

    return (
        <ChartContainer
            title="Active sales pricing"
            description="Current asking inventory positioned against the sold-market price cloud."
            height={280}
            className="border-white/5 bg-white/[0.02]"
        >
            <ScatterChart margin={{ top: 10, right: 20, left: 12, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} type="number" dataKey="area" name="Area" unit=" m²" />
                <YAxis
                    {...chartAxisProps}
                    type="number"
                    dataKey="pricePerM2"
                    name="Asking price / m²"
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                    width={64}
                />
                <Tooltip content={<ActiveSaleTooltip />} />
                <Scatter data={chartData} name="Asking price / m²" fill="#f59e0b" />
            </ScatterChart>
        </ChartContainer>
    );
}

export function RentalAggregationChart({
    data,
    filteredDispositions,
}: {
    data: DashboardExport;
    filteredDispositions?: string[];
}) {
    const chartData = (data.analysis.rentalAggregation ?? [])
        .filter((group) => !filteredDispositions || filteredDispositions.includes(group.disposition))
        .map((group) => ({
            disposition: group.disposition,
            minRent: Math.round(group.minRent),
            medianRent: Math.round(group.medianRent),
            maxRent: Math.round(group.maxRent),
        }));

    if (chartData.length === 0) {
        return null;
    }

    return (
        <ChartContainer
            title="Rental range by disposition"
            description="Minimum, median, and maximum asking rents across the current rental evidence."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 12, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} dataKey="disposition" />
                <YAxis
                    {...chartAxisProps}
                    tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
                    width={56}
                />
                <Tooltip
                    content={<ChartTooltipContent valueFormatter={(value) => formatCurrency(Number(value ?? 0))} />}
                />
                <Bar dataKey="minRent" name="Min rent" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
                <Bar dataKey="medianRent" name="Median rent" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                <Bar dataKey="maxRent" name="Max rent" fill="#a855f7" radius={[6, 6, 0, 0]} />
                <ReferenceLine
                    y={data.meta.target.monthlyRent}
                    stroke="#22c55e"
                    strokeDasharray="4 4"
                    label={{ value: "Target rent", fill: "#86efac", fontSize: 11 }}
                />
            </ComposedChart>
        </ChartContainer>
    );
}

export function InvestmentBenchmarkChart({ data }: { data: DashboardExport }) {
    const chartData = [
        {
            name: "Target net",
            annualReturn: Number(data.analysis.yield.netYield.toFixed(1)),
        },
        {
            name: "Market net",
            annualReturn: Number(data.analysis.yield.atMarketPrice.netYield.toFixed(1)),
        },
        ...data.benchmarks.investmentBenchmarks,
    ];

    return (
        <ChartContainer
            title="Return benchmark spread"
            description="Net yield versus the export's benchmark set."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <BarChart data={chartData} margin={{ top: 10, right: 20, left: 12, bottom: 24 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} dataKey="name" interval={0} angle={-16} textAnchor="end" height={52} />
                <YAxis {...chartAxisProps} tickFormatter={(value: number) => `${value}%`} width={52} />
                <Tooltip
                    content={
                        <ChartTooltipContent valueFormatter={(value) => formatSignedPercent(Number(value ?? 0), 1)} />
                    }
                />
                <Bar dataKey="annualReturn" radius={[8, 8, 0, 0]}>
                    {chartData.map((entry) => (
                        <Cell
                            key={entry.name}
                            fill={
                                entry.name === "Target net"
                                    ? "#f59e0b"
                                    : entry.name === "Market net"
                                      ? "#38bdf8"
                                      : "#64748b"
                            }
                        />
                    ))}
                </Bar>
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.16)" />
            </BarChart>
        </ChartContainer>
    );
}

export function InvestmentSensitivityChart({
    scenarios,
}: {
    scenarios: Array<{ label: string; grossYield: number; netYield: number }>;
}) {
    return (
        <ChartContainer
            title="Yield sensitivity"
            description="How the net and gross yield shift under transparent rent and price scenarios."
            height={320}
            className="border-white/5 bg-white/[0.02]"
        >
            <AreaChart data={scenarios} margin={{ top: 10, right: 20, left: 12, bottom: 12 }}>
                <CartesianGrid {...chartGridProps} />
                <XAxis {...chartAxisProps} dataKey="label" />
                <YAxis {...chartAxisProps} tickFormatter={(value: number) => `${value}%`} width={52} />
                <Tooltip
                    content={<ChartTooltipContent valueFormatter={(value) => formatPercent(Number(value ?? 0), 1)} />}
                />
                <Area type="monotone" dataKey="grossYield" name="Gross yield" stroke="#38bdf8" fill="#38bdf833" />
                <Area type="monotone" dataKey="netYield" name="Net yield" stroke="#f59e0b" fill="#f59e0b22" />
            </AreaChart>
        </ChartContainer>
    );
}

function formatTooltipDate(value: string): string {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
        return value;
    }

    return parsed.toLocaleString("en-GB", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function HistogramTooltip({
    active,
    payload,
    countLabel,
}: {
    active?: boolean;
    payload?: Array<{ payload?: DashboardExport["analysis"]["priceHistogram"][number] }>;
    countLabel: string;
}) {
    if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
        return null;
    }

    const item = payload[0].payload;

    return (
        <div className="min-w-56 rounded-xl border border-white/10 bg-slate-950/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-sm">
            <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-slate-300">{item.range}</div>
            <div className="font-mono text-slate-200">
                {item.count} {countLabel}
            </div>
            {item.provenance?.note ? (
                <div className="mt-2 text-[11px] font-mono leading-5 text-slate-400">{item.provenance.note}</div>
            ) : null}
        </div>
    );
}

function ActiveSaleTooltip({
    active,
    payload,
}: {
    active?: boolean;
    payload?: Array<{
        payload?: DashboardExport["listings"]["activeSales"][number] & {
            area: number;
            pricePerM2: number;
            address: string;
        };
    }>;
}) {
    if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
        return null;
    }

    const item = payload[0].payload;

    return (
        <div className="min-w-56 rounded-xl border border-white/10 bg-slate-950/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-sm">
            <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.2em] text-slate-300">{item.address}</div>
            <div className="space-y-1 font-mono text-slate-200">
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Area</span>
                    <span>{formatInteger(item.area ?? 0)} m²</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                    <span className="text-slate-400">Price / m²</span>
                    <span>{formatCurrency(item.pricePerM2 ?? 0)}</span>
                </div>
                {item.sourceContract ? (
                    <div className="flex items-center justify-between gap-4">
                        <span className="text-slate-400">Contract</span>
                        <span>{item.sourceContract}</span>
                    </div>
                ) : null}
                {item.provenance?.providerDetails[0] ? (
                    <div className="flex items-center justify-between gap-4">
                        <span className="text-slate-400">Fetched</span>
                        <span>{formatTooltipDate(item.provenance.providerDetails[0].fetchedAt)}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
