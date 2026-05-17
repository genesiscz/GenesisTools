import { ChartBox } from "@app/shops/ui/components/ChartBox";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { chartColors, chartSeriesPalette } from "@app/utils/ui/graphs/colors";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, Tooltip, XAxis, YAxis } from "recharts";

export interface SpendInsights {
    months: { month: string; total: number; currency: string; orders: number }[];
    byShop: { shop_origin: string; total: number; orders: number }[];
    byCategory: { category_path: string | null; total: number; items: number }[];
    topProducts: {
        master_product_id: number;
        name: string;
        units_total: number;
        spend_total: number;
        last_purchased_at: string;
    }[];
    counterfactual: {
        saved_now: number;
        would_have_saved_at_best: number;
        missed_drops: { master_id: number; name: string; paid_avg: number; best_seen: number; best_seen_at: string }[];
    };
}

interface Props {
    data: SpendInsights;
    onProductClick: (masterId: number) => void;
}

export function SpendSummary({ data, onProductClick }: Props): ReactNode {
    const allTime = data.months.reduce((a, m) => a + m.total, 0);
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <StatCard label="ALL-TIME SPEND" value={`${allTime.toLocaleString("cs-CZ")} CZK`} />
                <StatCard label="ORDERS" value={String(data.months.reduce((a, m) => a + m.orders, 0))} />
                <StatCard
                    label="WOULD'VE SAVED (90D)"
                    value={`${data.counterfactual.would_have_saved_at_best.toLocaleString("cs-CZ")} CZK`}
                    accent
                />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Card className="border-zinc-800 bg-zinc-950">
                    <CardHeader>
                        <CardTitle className="font-mono text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
                            MONTH-BY-MONTH SPEND
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <ChartBox height={176}>
                            {({ width, height }) => (
                                <BarChart data={data.months} width={width} height={height}>
                                    <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
                                    <XAxis
                                        dataKey="month"
                                        stroke={chartColors.axis}
                                        tick={{ fontSize: 10, fontFamily: "monospace" }}
                                    />
                                    <YAxis
                                        stroke={chartColors.axis}
                                        tick={{ fontSize: 10, fontFamily: "monospace" }}
                                        tickFormatter={(v: number) => `${v}`}
                                    />
                                    <Tooltip
                                        contentStyle={{
                                            background: chartColors.tooltipBg,
                                            border: `1px solid ${chartColors.tooltipBorder}`,
                                            fontFamily: "monospace",
                                            fontSize: 11,
                                        }}
                                    />
                                    <Bar dataKey="total" fill={chartSeriesPalette[0]} />
                                </BarChart>
                            )}
                        </ChartBox>
                    </CardContent>
                </Card>

                <Card className="border-zinc-800 bg-zinc-950">
                    <CardHeader>
                        <CardTitle className="font-mono text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
                            PER-SHOP SPLIT
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {data.byShop.length === 0 ? (
                            <div className="h-44 flex items-center justify-center text-xs text-muted-foreground font-mono">
                                no orders yet
                            </div>
                        ) : data.byShop.length === 1 ? (
                            <div className="h-44 flex flex-col items-center justify-center gap-1 font-mono">
                                <div className="text-3xl tabular-nums text-[var(--color-neon-cyan)]">100%</div>
                                <div className="text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
                                    {data.byShop[0].shop_origin}
                                </div>
                            </div>
                        ) : (
                            <ChartBox height={176}>
                                {({ width, height }) => (
                                    <PieChart width={width} height={height}>
                                        <Pie
                                            data={data.byShop}
                                            dataKey="total"
                                            nameKey="shop_origin"
                                            outerRadius={60}
                                            label={renderShopPieLabel}
                                            labelLine={false}
                                        >
                                            {data.byShop.map((_, i) => (
                                                <Cell
                                                    key={i}
                                                    fill={chartSeriesPalette[i % chartSeriesPalette.length]}
                                                />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{
                                                background: chartColors.tooltipBg,
                                                border: `1px solid ${chartColors.tooltipBorder}`,
                                                fontFamily: "monospace",
                                                fontSize: 11,
                                            }}
                                        />
                                    </PieChart>
                                )}
                            </ChartBox>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Card className="border-zinc-800 bg-zinc-950">
                <CardHeader>
                    <CardTitle className="font-mono text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
                        TOP PRODUCTS
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                    {data.topProducts.length === 0 ? (
                        <div className="text-xs text-muted-foreground font-mono">no data yet</div>
                    ) : (
                        data.topProducts.map((p) => (
                            <button
                                key={p.master_product_id}
                                type="button"
                                onClick={() => onProductClick(p.master_product_id)}
                                className="w-full flex justify-between items-center text-left text-xs font-mono py-1 px-2 rounded border-l-2 border-transparent transition-colors hover:bg-cyan-500/5 hover:border-cyan-500/40"
                            >
                                <span className="truncate text-foreground">{p.name}</span>
                                <span className="text-muted-foreground tabular-nums">
                                    {p.units_total.toFixed(0)} ks · {p.spend_total.toLocaleString("cs-CZ")} CZK
                                </span>
                            </button>
                        ))
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

interface PieLabelProps {
    percent?: number;
    name?: string;
}

function renderShopPieLabel({ percent, name }: PieLabelProps): string {
    if (typeof percent !== "number" || !name) {
        return "";
    }

    return `${name} · ${(percent * 100).toFixed(0)}%`;
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
    return (
        <Card
            className={`border-zinc-800 bg-zinc-950 transition-all duration-150 hover:-translate-y-0.5 hover:border-cyan-500/30 cursor-default ${
                accent ? "hover:shadow-[0_0_20px_rgba(255,200,0,0.15)] hover:border-amber-400/40" : ""
            }`}
        >
            <CardContent className="py-4">
                <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">{label}</div>
                <div
                    className={`font-mono text-2xl ${accent ? "text-[var(--color-neon-cyan)]" : "text-foreground"} tabular-nums`}
                >
                    {value}
                </div>
            </CardContent>
        </Card>
    );
}
