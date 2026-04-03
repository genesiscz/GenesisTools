import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Progress } from "@ui/components/progress";
import { cn } from "@ui/lib/utils";
import {
    Activity,
    BarChart3,
    Building2,
    CircleDollarSign,
    ExternalLink,
    Landmark,
    Layers3,
    Percent,
    ShieldCheck,
    Sparkles,
    Target,
    Timer,
    TrendingUp,
} from "lucide-react";
import { ActiveSalesChart, ComparablesScatterChart, DistributionHistogram, TrendChartCard } from "./AnalysisCharts";
import { AnalysisMetricCard } from "./AnalysisMetricCard";
import { DataTable } from "./DataTable";
import { InfoBox } from "./InfoBox";
import { ScoreGauge } from "./ScoreGauge";
import { SectionTitle } from "./SectionTitle";
import {
    formatCompactCurrency,
    formatCurrency,
    formatDays,
    formatInteger,
    formatPercent,
    formatPercentile,
    formatSignedPercent,
    getConfidenceTone,
    getInvestmentSummary,
    getMedianActivePricePerM2,
    getProviderCounts,
    getScoreTone,
    getSentimentTone,
    getTargetPricePerM2,
} from "./utils";

interface AnalysisSectionProps {
    data: DashboardExport;
}

export function OverviewTab({ data }: AnalysisSectionProps) {
    const summary = getInvestmentSummary(data);
    const targetPricePerM2 = getTargetPricePerM2(data);
    const providerCounts = getProviderCounts(data);
    const activeMedian = getMedianActivePricePerM2(data);
    const activeGap = activeMedian > 0 ? ((activeMedian - targetPricePerM2) / activeMedian) * 100 : 0;
    const priceGap = targetPricePerM2 - data.analysis.comparables.median;

    return (
        <div className="space-y-4">
            <SectionTitle
                title="Overview"
                subtitle="Stored snapshot across pricing, yield, provider depth, and analyst conviction."
            />
            <Card className="border-white/5 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.18),transparent_40%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_38%),rgba(255,255,255,0.02)]">
                <CardContent className="grid gap-6 p-6 lg:grid-cols-[1.3fr_0.7fr]">
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge className="border-amber-500/20 bg-amber-500/10 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-200">
                                Overview
                            </Badge>
                            <Badge variant="outline" className="border-white/10 font-mono text-[10px] text-slate-300">
                                {data.meta.target.constructionType}
                            </Badge>
                            <Badge variant="outline" className="border-white/10 font-mono text-[10px] text-slate-300">
                                {data.meta.target.disposition}
                            </Badge>
                        </div>
                        <div>
                            <h3 className="text-2xl font-semibold tracking-tight text-white">
                                {data.meta.target.district} is a{" "}
                                <span className={getScoreTone(summary.overall)}>
                                    {summary.recommendation.toLowerCase()}
                                </span>{" "}
                                for this target.
                            </h3>
                            <p className="mt-2 max-w-3xl text-sm font-mono leading-6 text-slate-400">
                                The target sits at {formatPercentile(data.analysis.comparables.targetPercentile)} of
                                sold comparables, delivers {formatPercent(data.analysis.yield.netYield)} net yield, and
                                carries a {summary.grade}
                                grade with {summary.overall}/100 conviction.
                            </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <AnalysisMetricCard
                                label="Target Price / m²"
                                value={formatCurrency(targetPricePerM2)}
                                hint={`${priceGap >= 0 ? "Above" : "Below"} sold median by ${formatCompactCurrency(Math.abs(priceGap))}`}
                                icon={Target}
                                valueClassName={getSentimentTone(-priceGap)}
                            />
                            <AnalysisMetricCard
                                label="Net Yield"
                                value={formatPercent(data.analysis.yield.netYield)}
                                hint={`Gross ${formatPercent(data.analysis.yield.grossYield)} | Payback ${data.analysis.yield.paybackYears.toFixed(1)}y`}
                                icon={Percent}
                                valueClassName={getScoreTone(data.analysis.yield.netYield * 15)}
                            />
                            <AnalysisMetricCard
                                label="Active Sales Gap"
                                value={activeMedian > 0 ? formatSignedPercent(activeGap) : "No data"}
                                hint={
                                    activeMedian > 0
                                        ? `Target versus ${formatCurrency(activeMedian)} median asking price / m²`
                                        : "No active asking inventory returned"
                                }
                                icon={Layers3}
                                valueClassName={activeMedian > 0 ? getSentimentTone(activeGap) : "text-slate-300"}
                            />
                        </div>
                    </div>
                    <Card className="border-white/10 bg-slate-950/60">
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                                <Sparkles className="h-4 w-4 text-amber-300" />
                                Analyst signal
                            </CardTitle>
                            <CardDescription className="font-mono text-xs text-slate-500">
                                A fast verdict built from the current dashboard export.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <div className={cn("text-5xl font-black font-mono", getScoreTone(summary.overall))}>
                                        {summary.grade}
                                    </div>
                                    <div className="mt-1 text-sm font-mono text-slate-400">{summary.recommendation}</div>
                                </div>
                                <ScoreGauge score={summary.overall} label="Investment score" />
                            </div>
                            <Progress value={summary.overall} className="h-2 bg-white/5" />
                            <InfoBox title="Analyst signal" tone="positive">
                                {summary.reasoning.slice(0, 3).join(" ")}
                            </InfoBox>
                        </CardContent>
                    </Card>
                </CardContent>
            </Card>

            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Building2 className="h-4 w-4 text-cyan-300" />
                            Market snapshot
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <AnalysisMetricCard
                            label="Sold comps"
                            value={String(data.analysis.comparables.count)}
                            hint={`Median ${formatCurrency(data.analysis.comparables.median)} / m²`}
                            icon={BarChart3}
                        />
                        <AnalysisMetricCard
                            label="Active sales"
                            value={String(data.listings.activeSales.length)}
                            hint={
                                data.listings.activeSales.length > 0
                                    ? `Median ${formatCurrency(activeMedian)} / m²`
                                    : "No active sales in current export"
                            }
                            icon={Layers3}
                        />
                        <AnalysisMetricCard
                            label="Rental listings"
                            value={String(data.listings.rentals.length)}
                            hint={`Median DOM ${formatDays(data.analysis.timeOnMarket.median)}`}
                            icon={Landmark}
                        />
                        <AnalysisMetricCard
                            label="Discount"
                            value={formatPercent(data.analysis.discount.avgDiscount)}
                            hint={`Median ${formatPercent(data.analysis.discount.medianDiscount)} | Max ${formatPercent(data.analysis.discount.maxDiscount)}`}
                            icon={CircleDollarSign}
                        />
                    </CardContent>
                </Card>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <ShieldCheck className="h-4 w-4 text-lime-300" />
                            Provider summary
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            {providerCounts.healthy}/
                            {providerCounts.providerSummary.length || data.meta.providers.length} providers responded,
                            {` `}
                            {providerCounts.total} rows fetched.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {(providerCounts.providerSummary.length > 0
                            ? providerCounts.providerSummary
                            : data.meta.providers.map((provider) => ({
                              provider,
                              count: 0,
                              fetchedAt: data.meta.generatedAt,
                              sourceContract: provider,
                              error: undefined,
                          }))
                        ).map((provider) => (
                            <div
                                key={`${provider.provider}-${provider.sourceContract}`}
                                className="flex items-center justify-between rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2"
                            >
                                <div>
                                    <div className="text-xs font-mono uppercase tracking-[0.2em] text-slate-300">
                                        {provider.provider}
                                    </div>
                                    <div className="text-[11px] font-mono text-slate-500">
                                        {provider.sourceContract}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-sm font-mono text-white">{provider.count}</div>
                                    <div
                                        className={cn(
                                            "text-[11px] font-mono",
                                            provider.error ? "text-red-300" : "text-green-300"
                                        )}
                                    >
                                        {provider.error ? "error" : "ok"}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export function PriceDistributionTab({ data }: AnalysisSectionProps) {
    return (
        <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
                <DistributionHistogram
                    title="Price per m² distribution"
                    description="Sold-comparable density across price buckets from the exported histogram."
                    data={data.analysis.priceHistogram}
                    countLabel="sales"
                />
                <DistributionHistogram
                    title="Days on market distribution"
                    description="How quickly sold comparables moved, using the exported DOM histogram."
                    data={data.analysis.domDistribution}
                    countLabel="listings"
                />
            </div>
            <div className="grid gap-4 xl:grid-cols-4">
                <AnalysisMetricCard
                    label="Median"
                    value={formatCurrency(data.analysis.comparables.median)}
                    hint={`Mean ${formatCurrency(data.analysis.comparables.mean)}`}
                    icon={CircleDollarSign}
                />
                <AnalysisMetricCard
                    label="Interquartile range"
                    value={`${formatCompactCurrency(data.analysis.comparables.p25)} - ${formatCompactCurrency(data.analysis.comparables.p75)}`}
                    hint="P25 to P75 sold pricing band"
                    icon={Layers3}
                />
                <AnalysisMetricCard
                    label="Target percentile"
                    value={formatPercentile(data.analysis.comparables.targetPercentile)}
                    hint="Relative positioning versus sold comparables"
                    icon={Target}
                />
                <AnalysisMetricCard
                    label="Market tempo"
                    value={formatDays(data.analysis.timeOnMarket.median)}
                    hint={`Min ${formatDays(data.analysis.timeOnMarket.min)} | Max ${formatDays(data.analysis.timeOnMarket.max)}`}
                    icon={Timer}
                />
            </div>
        </div>
    );
}

export function TrendTab({ data }: AnalysisSectionProps) {
    const firstTrend = data.analysis.trends[0];
    const lastTrend = data.analysis.trends[data.analysis.trends.length - 1];
    const totalChange =
        firstTrend && lastTrend && firstTrend.medianPricePerM2 > 0
            ? ((lastTrend.medianPricePerM2 - firstTrend.medianPricePerM2) / firstTrend.medianPricePerM2) * 100
            : 0;

    return (
        <div className="space-y-4">
            <TrendChartCard data={data} />
            <div className="grid gap-4 xl:grid-cols-4">
                <AnalysisMetricCard
                    label="Latest median"
                    value={lastTrend ? formatCurrency(lastTrend.medianPricePerM2) : "No data"}
                    hint={
                        lastTrend
                            ? `${lastTrend.count} comparable sales in ${lastTrend.period}`
                            : "Trend export is empty"
                    }
                    icon={BarChart3}
                />
                <AnalysisMetricCard
                    label="Period change"
                    value={formatSignedPercent(totalChange)}
                    hint={
                        firstTrend && lastTrend ? `${firstTrend.period} to ${lastTrend.period}` : "Insufficient periods"
                    }
                    icon={TrendingUp}
                    valueClassName={getSentimentTone(totalChange)}
                />
                <AnalysisMetricCard
                    label="Momentum"
                    value={data.analysis.momentum?.momentum ?? "derived"}
                    hint={
                        data.analysis.momentum?.interpretation ?? "Momentum interpretation not returned by the backend"
                    }
                    icon={Activity}
                />
                <AnalysisMetricCard
                    label="Velocity"
                    value={data.analysis.momentum ? formatSignedPercent(data.analysis.momentum.priceVelocity) : "N/A"}
                    hint={
                        data.analysis.momentum
                            ? `${data.analysis.momentum.direction} with ${data.analysis.momentum.confidence} confidence`
                            : "Momentum model did not return a score"
                    }
                    icon={Sparkles}
                    valueClassName={
                        data.analysis.momentum
                            ? getSentimentTone(data.analysis.momentum.priceVelocity)
                            : "text-slate-300"
                    }
                />
            </div>
        </div>
    );
}

export function ComparablesTab({ data }: AnalysisSectionProps) {
    return (
        <div className="space-y-4">
            <SectionTitle
                title="Comparables"
                subtitle="Sold evidence, active asking context, and direct source links for every exported sale."
            />
            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <ComparablesScatterChart data={data} />
                <ActiveSalesChart data={data} />
            </div>
            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                        <Building2 className="h-4 w-4 text-amber-300" />
                        Sold comparables
                    </CardTitle>
                    <CardDescription className="font-mono text-xs text-slate-500">
                        Ordered export of sold listings used for market pricing.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    <DataTable
                        columns={[
                            { key: "address", header: "Address", className: "max-w-[240px] truncate text-slate-200" },
                            { key: "disposition", header: "Disp.", className: "text-slate-400" },
                            { key: "areaLabel", header: "Area", align: "right" },
                            { key: "priceLabel", header: "Price", align: "right" },
                            { key: "pricePerM2Label", header: "CZK / m²", align: "right", className: "text-cyan-300" },
                            { key: "domLabel", header: "DOM", align: "right", className: "text-slate-400" },
                            { key: "discountLabel", header: "Discount", align: "right", className: "text-amber-200" },
                            {
                                key: "link",
                                header: "Link",
                                render: (row) =>
                                    row.link ? (
                                        <a
                                            href={String(row.link)}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex text-slate-500 transition-colors hover:text-amber-300"
                                        >
                                            <ExternalLink className="h-3.5 w-3.5" />
                                        </a>
                                    ) : null,
                            },
                        ]}
                        rows={data.listings.sold.map((listing) => ({
                            ...listing,
                            areaLabel: `${formatInteger(listing.area)} m²`,
                            priceLabel: formatCompactCurrency(listing.price),
                            pricePerM2Label: formatCompactCurrency(listing.pricePerM2),
                            domLabel: listing.daysOnMarket ? formatDays(listing.daysOnMarket) : "-",
                            discountLabel: listing.discount != null ? formatPercent(listing.discount) : "-",
                        }))}
                        getRowKey={(row, index) => `${String(row.address)}-${index}`}
                        emptyMessage="No sold comparables were exported."
                    />
                </CardContent>
            </Card>
        </div>
    );
}

export function RentalsTab({ data }: AnalysisSectionProps) {
    const aggregated = data.analysis.rentalAggregation ?? [];

    return (
        <div className="space-y-4">
            <SectionTitle
                title="Rentals"
                subtitle="Deduplicated rental supply grouped by disposition, with provider-level evidence and raw rows."
            />
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                {aggregated.length > 0 ? (
                    aggregated.map((group) => (
                        <Card key={group.disposition} className="border-white/5 bg-white/[0.02]">
                            <CardHeader className="pb-3">
                                <div className="flex items-center justify-between gap-3">
                                    <CardTitle className="text-sm font-mono text-white">{group.disposition}</CardTitle>
                                    <Badge
                                        className={cn(
                                            "border font-mono text-[10px] uppercase tracking-[0.2em]",
                                            getConfidenceTone(group.confidence)
                                        )}
                                    >
                                        {group.confidence}
                                    </Badge>
                                </div>
                                <CardDescription className="font-mono text-xs text-slate-500">
                                    {group.count} deduplicated rental listings
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <div className="grid grid-cols-2 gap-3">
                                    <AnalysisMetricCard
                                        label="Median rent"
                                        value={formatCompactCurrency(group.medianRent)}
                                        hint={`Mean ${formatCompactCurrency(group.meanRent)}`}
                                        icon={Landmark}
                                        className="bg-slate-950/40"
                                    />
                                    <AnalysisMetricCard
                                        label="Rent / m²"
                                        value={formatCurrency(group.rentPerM2)}
                                        hint={`${formatCompactCurrency(group.minRent)} - ${formatCompactCurrency(group.maxRent)}`}
                                        icon={Percent}
                                        className="bg-slate-950/40"
                                    />
                                </div>
                                <div className="space-y-2">
                                    {Object.entries(group.sources).map(([provider, stats]) => (
                                        <div
                                            key={provider}
                                            className="flex items-center justify-between text-xs font-mono text-slate-400"
                                        >
                                            <span className="uppercase tracking-[0.2em] text-slate-500">
                                                {provider}
                                            </span>
                                            <span>
                                                {stats.count} listings · {formatCompactCurrency(stats.median)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    ))
                ) : (
                    <Card className="border-white/5 bg-white/[0.02] lg:col-span-2 xl:col-span-3">
                        <CardContent className="p-6">
                            <InfoBox title="Rental aggregation" tone="warning">
                                The backend did not return aggregated rental statistics for this run.
                            </InfoBox>
                        </CardContent>
                    </Card>
                )}
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Landmark className="h-4 w-4 text-cyan-300" />
                            Rental listings
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="px-0">
                        <DataTable
                            columns={[
                                { key: "address", header: "Address", className: "max-w-[220px] truncate text-slate-200" },
                                { key: "disposition", header: "Disp.", className: "text-slate-400" },
                                { key: "areaLabel", header: "Area", align: "right" },
                                { key: "rentLabel", header: "Rent", align: "right" },
                                { key: "rentPerM2Label", header: "Rent / m²", align: "right", className: "text-cyan-300" },
                            ]}
                            rows={data.listings.rentals.slice(0, 12).map((listing) => ({
                                ...listing,
                                areaLabel: `${formatInteger(listing.area)} m²`,
                                rentLabel: formatCompactCurrency(listing.rent),
                                rentPerM2Label: formatCurrency(listing.rentPerM2),
                            }))}
                            getRowKey={(row, index) => `${String(row.address)}-${index}`}
                            emptyMessage="No rental listings were exported."
                        />
                    </CardContent>
                </Card>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Landmark className="h-4 w-4 text-lime-300" />
                            MF benchmarks
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            Reference price inputs returned alongside rental analysis.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {data.benchmarks.mf.slice(0, 8).map((benchmark) => (
                            <div
                                key={`${benchmark.cadastralUnit}-${benchmark.sizeCategory}`}
                                className="rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2"
                            >
                                <div className="flex items-center justify-between gap-4">
                                    <div>
                                        <div className="text-xs font-mono text-slate-200">{benchmark.municipality}</div>
                                        <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-slate-500">
                                            {benchmark.cadastralUnit} · {benchmark.sizeCategory}
                                        </div>
                                    </div>
                                    <div className="text-right font-mono">
                                        <div className="text-sm text-lime-300">
                                            {formatCompactCurrency(benchmark.referencePrice)}
                                        </div>
                                        <div className="text-[11px] text-slate-500">
                                            coverage {benchmark.coverageScore}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export function InvestmentTab({ data }: AnalysisSectionProps) {
    const summary = getInvestmentSummary(data);
    const targetPricePerM2 = getTargetPricePerM2(data);
    const marketPricePerM2 = data.analysis.yield.atMarketPrice.price / data.meta.target.area;

    return (
        <div className="space-y-4">
            <SectionTitle
                title="Investment"
                subtitle="Pricing edge, yield spread, benchmark context, and the current score rationale."
            />
            <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <ShieldCheck className="h-4 w-4 text-amber-300" />
                            Score breakdown
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <div className={cn("text-5xl font-black font-mono", getScoreTone(summary.overall))}>
                                    {summary.grade}
                                </div>
                                <div className="text-sm font-mono text-slate-400">{summary.recommendation}</div>
                            </div>
                            <ScoreGauge score={summary.overall} label="Overall" />
                        </div>
                        <Progress value={summary.overall} className="h-2 bg-white/5" />
                        <div className="space-y-2">
                            {summary.reasoning.map((item) => (
                                <div
                                    key={item}
                                    className="flex items-start gap-2 rounded-lg border border-white/5 bg-slate-950/40 px-3 py-2 text-xs font-mono text-slate-400"
                                >
                                    <span className="mt-1 size-1.5 rounded-full bg-amber-300" />
                                    <span>{item}</span>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>

                <div className="grid gap-4 sm:grid-cols-2">
                    <AnalysisMetricCard
                        label="Target purchase"
                        value={formatCompactCurrency(data.meta.target.price)}
                        hint={`${formatCurrency(targetPricePerM2)} / m²`}
                        icon={Target}
                    />
                    <AnalysisMetricCard
                        label="Market purchase"
                        value={formatCompactCurrency(data.analysis.yield.atMarketPrice.price)}
                        hint={`${formatCurrency(marketPricePerM2)} / m²`}
                        icon={Building2}
                    />
                    <AnalysisMetricCard
                        label="Net yield gap"
                        value={formatSignedPercent(
                            data.analysis.yield.netYield - data.analysis.yield.atMarketPrice.netYield
                        )}
                        hint={`Target ${formatPercent(data.analysis.yield.netYield)} vs market ${formatPercent(data.analysis.yield.atMarketPrice.netYield)}`}
                        icon={Percent}
                        valueClassName={getSentimentTone(
                            data.analysis.yield.netYield - data.analysis.yield.atMarketPrice.netYield
                        )}
                    />
                    <AnalysisMetricCard
                        label="Payback edge"
                        value={`${(data.analysis.yield.atMarketPrice.paybackYears - data.analysis.yield.paybackYears).toFixed(1)}y`}
                        hint={`Target ${data.analysis.yield.paybackYears.toFixed(1)}y vs market ${data.analysis.yield.atMarketPrice.paybackYears.toFixed(1)}y`}
                        icon={Timer}
                        valueClassName={getSentimentTone(
                            data.analysis.yield.atMarketPrice.paybackYears - data.analysis.yield.paybackYears
                        )}
                    />
                </div>
            </div>

            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                        <Percent className="h-4 w-4 text-cyan-300" />
                        Investment benchmarks
                    </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 lg:grid-cols-3">
                    {data.benchmarks.investmentBenchmarks.map((benchmark) => {
                        const spread = data.analysis.yield.netYield - benchmark.annualReturn;

                        return (
                            <Card key={benchmark.name} className="border-white/5 bg-slate-950/40">
                                <CardContent className="space-y-2 p-4">
                                    <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-slate-500">
                                        {benchmark.name}
                                    </div>
                                    <div className="flex items-end justify-between gap-4">
                                        <div className="text-lg font-semibold font-mono text-white">
                                            {formatPercent(benchmark.annualReturn)}
                                        </div>
                                        <div className={cn("text-sm font-mono", getSentimentTone(spread))}>
                                            {formatSignedPercent(spread)}
                                        </div>
                                    </div>
                                    <p className="text-xs font-mono leading-5 text-slate-400">
                                        Net yield spread versus this benchmark.
                                    </p>
                                </CardContent>
                            </Card>
                        );
                    })}
                </CardContent>
            </Card>
        </div>
    );
}

export function VerdictTab({ data }: AnalysisSectionProps) {
    const summary = getInvestmentSummary(data);
    const providerCounts = getProviderCounts(data);
    const verdictLines = [
        `${summary.recommendation} with ${summary.grade} / ${summary.overall} based on current sold and rental evidence.`,
        `Target pricing sits at the ${data.analysis.comparables.targetPercentile.toFixed(0)}th percentile with ${formatPercent(data.analysis.yield.netYield)} net yield.`,
        `${data.analysis.comparables.count} sold comparables and ${data.listings.rentals.length} rentals were included in this export.`,
        data.analysis.momentum
            ? `Momentum is ${data.analysis.momentum.direction} with ${data.analysis.momentum.confidence} confidence: ${data.analysis.momentum.interpretation}`
            : `Momentum data was not returned, so the verdict leans more heavily on pricing and yield.`,
    ];

    return (
        <div className="space-y-4">
            <SectionTitle
                title="Verdict"
                subtitle="Bottom-line recommendation with evidence depth and explicit provenance from the current export."
            />
            <Card className="border-white/5 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(245,158,11,0.14),transparent_36%),rgba(255,255,255,0.02)]">
                <CardContent className="grid gap-6 p-6 lg:grid-cols-[1.1fr_0.9fr]">
                    <div className="space-y-4">
                        <div className="flex items-center gap-2">
                            <Badge
                                className={cn(
                                    "border font-mono text-[10px] uppercase tracking-[0.24em]",
                                    summary.overall >= 65
                                        ? "border-green-500/20 bg-green-500/10 text-green-200"
                                        : summary.overall >= 45
                                          ? "border-amber-500/20 bg-amber-500/10 text-amber-200"
                                          : "border-red-500/20 bg-red-500/10 text-red-200"
                                )}
                            >
                                Verdict
                            </Badge>
                            <span className="text-xs font-mono text-slate-500">
                                Generated from the current dashboard export only.
                            </span>
                        </div>
                        <div>
                            <h3 className="text-3xl font-semibold tracking-tight text-white">
                                {summary.recommendation}
                            </h3>
                            <p className="mt-3 max-w-3xl text-sm font-mono leading-6 text-slate-400">
                                {verdictLines[0]} {verdictLines[1]}
                            </p>
                        </div>
                        <div className="space-y-2">
                            {verdictLines.slice(2).map((line, index) => (
                                <InfoBox key={line} tone={index === 0 ? "info" : "warning"}>
                                    {line}
                                </InfoBox>
                            ))}
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <Card className="border-white/10 bg-slate-950/60 sm:col-span-2">
                            <CardContent className="flex flex-col items-center gap-3 p-4">
                                <ScoreGauge score={summary.overall} label="Conviction" />
                                <div className={cn("text-sm font-mono", getScoreTone(summary.overall))}>
                                    {summary.grade} grade
                                </div>
                            </CardContent>
                        </Card>
                        <AnalysisMetricCard
                            label="Conviction"
                            value={`${summary.overall}/100`}
                            hint={`${summary.grade} grade from the returned investment score or fallback computation`}
                            icon={ShieldCheck}
                            valueClassName={getScoreTone(summary.overall)}
                        />
                        <AnalysisMetricCard
                            label="Providers"
                            value={`${providerCounts.healthy}/${providerCounts.providerSummary.length || data.meta.providers.length}`}
                            hint={`${providerCounts.total} rows across responding sources`}
                            icon={Layers3}
                        />
                        <AnalysisMetricCard
                            label="Rental evidence"
                            value={String(data.listings.rentals.length)}
                            hint={`${data.analysis.rentalAggregation?.length ?? 0} aggregated disposition groups`}
                            icon={Landmark}
                        />
                        <AnalysisMetricCard
                            label="Sold evidence"
                            value={String(data.analysis.comparables.count)}
                            hint={`${data.listings.activeSales.length} active asking listings in the same export`}
                            icon={Building2}
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
