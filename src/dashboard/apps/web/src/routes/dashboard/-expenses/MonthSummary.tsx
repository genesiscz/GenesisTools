import { Card } from "@ui/components/card";
import { ProgressBar, StatCardNexus } from "@ui/custom";
import { Layers, Receipt, Wallet } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { CategoryBucket, MonthSummary as MonthSummaryData } from "@/lib/expenses/derive";
import { formatCents } from "@/lib/expenses/money";

interface MonthSummaryProps {
    summary: MonthSummaryData;
    monthLabel: string;
}

interface ChartTooltipProps {
    active?: boolean;
    payload?: Array<{ payload: CategoryBucket }>;
    currency: string;
}

function ChartTooltip({ active, payload, currency }: ChartTooltipProps) {
    if (!active || !payload?.[0]) {
        return null;
    }

    const bucket = payload[0].payload;

    return (
        <div className="rounded-lg border border-border bg-popover/95 p-3 shadow-xl backdrop-blur-md">
            <div className="mb-1 flex items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: bucket.color }} />
                <span className="text-sm font-semibold text-foreground">{bucket.label}</span>
            </div>
            <p className="text-sm tabular-nums text-foreground">{formatCents(bucket.totalCents, currency)}</p>
            <p className="text-xs text-muted-foreground">
                {bucket.percentage.toFixed(0)}% · {bucket.count} item{bucket.count !== 1 ? "s" : ""}
            </p>
        </div>
    );
}

export function MonthSummary({ summary, monthLabel }: MonthSummaryProps) {
    const { totalCents, count, buckets, currency } = summary;
    const topBuckets = buckets.slice(0, 5);

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="flex flex-col gap-3 lg:col-span-1">
                <StatCardNexus
                    icon={<Wallet />}
                    value={formatCents(totalCents, currency)}
                    label={`Spent in ${monthLabel}`}
                    color="primary"
                />
                <div className="grid grid-cols-2 gap-3">
                    <StatCardNexus icon={<Receipt />} value={String(count)} label="Expenses" color="accent" />
                    <StatCardNexus icon={<Layers />} value={String(buckets.length)} label="Categories" color="accent" />
                </div>
            </div>

            <Card variant="wow-static" className="rounded-2xl p-5 lg:col-span-2" data-testid="expense-chart">
                <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">Where it went</h3>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">
                        {monthLabel}
                    </span>
                </div>

                <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2">
                    <div className="h-52">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={buckets}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={52}
                                    outerRadius={82}
                                    paddingAngle={2}
                                    dataKey="totalCents"
                                    nameKey="label"
                                    stroke="transparent"
                                >
                                    {buckets.map((bucket) => (
                                        <Cell
                                            key={bucket.category}
                                            fill={bucket.color}
                                            style={{ filter: `drop-shadow(0 0 5px ${bucket.color}66)` }}
                                        />
                                    ))}
                                </Pie>
                                <Tooltip content={<ChartTooltip currency={currency} />} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="flex flex-col gap-3" data-testid="expense-top-categories">
                        {topBuckets.map((bucket) => (
                            <div key={bucket.category} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                    <span className="flex items-center gap-1.5 text-foreground/80">
                                        <span
                                            aria-hidden
                                            className="h-2 w-2 rounded-full"
                                            style={{ backgroundColor: bucket.color }}
                                        />
                                        {bucket.label}
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                        {formatCents(bucket.totalCents, currency)}
                                    </span>
                                </div>
                                <ProgressBar value={bucket.percentage} max={100} color={bucket.color} />
                            </div>
                        ))}
                    </div>
                </div>
            </Card>
        </div>
    );
}
