import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Progress } from "@ui/components/progress";
import { ScrollArea } from "@ui/components/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
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
import { useMemo, useState } from "react";
import { fmtDateTime, fmtPercentile } from "../../lib/format";
import {
    ActiveSalesChart,
    ComparablesScatterChart,
    DistributionHistogram,
    InvestmentBenchmarkChart,
    InvestmentSensitivityChart,
    MfRentComparisonChart,
    RentalAggregationChart,
    TrendChartCard,
} from "./AnalysisCharts";
import { AnalysisMetricCard } from "./AnalysisMetricCard";
import { DataProvenance } from "./DataProvenance";
import { DataTable } from "./DataTable";
import { getMomentumCardModel, getScoreCardModel } from "./display-model";
import { InfoBox } from "./InfoBox";
import { ScoreGauge } from "./ScoreGauge";
import { SectionTitle } from "./SectionTitle";
import { summarizeProviderMessage } from "./shared";
import {
    formatCompactCurrency,
    formatCurrency,
    formatDays,
    formatInteger,
    formatPercent,
    formatPercentile,
    formatSignedPercent,
    getComparableGapSummary,
    getComparableNarrative,
    getConfidenceTone,
    getInvestmentSummary,
    getMedianActivePricePerM2,
    getProviderCounts,
    getProviderHealth,
    getScoreTone,
    getSentimentTone,
    getTargetPricePerM2,
    hasSoldComparableEvidence,
} from "./utils";

interface AnalysisSectionProps {
    data: DashboardExport;
}

function formatFetchedAt(value: string): string {
    return fmtDateTime(value, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function getPrimaryFetchedAt(provenance?: DashboardExport["analysis"]["comparables"]["provenance"]): string {
    const fetchedAt = provenance?.providerDetails[0]?.fetchedAt;

    if (!fetchedAt) {
        return "-";
    }

    return formatFetchedAt(fetchedAt);
}

export function OverviewTab({ data }: AnalysisSectionProps) {
    const summary = getInvestmentSummary(data);
    const scoreModel = getScoreCardModel(data);
    const targetPricePerM2 = getTargetPricePerM2(data);
    const providerCounts = getProviderCounts(data);
    const activeMedian = getMedianActivePricePerM2(data);
    const activeGap = activeMedian > 0 ? ((activeMedian - targetPricePerM2) / activeMedian) * 100 : 0;
    const hasSoldEvidence = hasSoldComparableEvidence(data);

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
                                <span className={getScoreTone(scoreModel.score)}>
                                    {scoreModel.recommendationLabel.toLowerCase()}
                                </span>{" "}
                                for this target.
                            </h3>
                            <p className="mt-2 max-w-3xl text-sm font-mono leading-6 text-slate-400">
                                {getComparableNarrative(data)} It delivers {formatPercent(data.analysis.yield.netYield)}{" "}
                                net yield and carries a {scoreModel.grade} grade with {scoreModel.score}/100 conviction.
                            </p>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <AnalysisMetricCard
                                label="Target Price / m²"
                                value={formatCurrency(targetPricePerM2)}
                                hint={getComparableGapSummary(data)}
                                icon={Target}
                                valueClassName={
                                    hasSoldEvidence
                                        ? getSentimentTone(data.analysis.comparables.median - targetPricePerM2)
                                        : "text-slate-300"
                                }
                            />
                            <AnalysisMetricCard
                                label="Net Yield"
                                value={formatPercent(data.analysis.yield.netYield)}
                                hint={`Gross ${formatPercent(data.analysis.yield.grossYield)} | Payback ${data.analysis.yield.paybackYears?.toFixed(1) ?? "—"}y`}
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
                                    <div
                                        className={cn("text-5xl font-black font-mono", getScoreTone(scoreModel.score))}
                                    >
                                        {scoreModel.grade}
                                    </div>
                                    <div className="mt-1 text-sm font-mono text-slate-400">
                                        {scoreModel.recommendationLabel}
                                    </div>
                                </div>
                                <ScoreGauge score={scoreModel.score} label="Investment score" />
                            </div>
                            <Progress value={scoreModel.score} className="h-2 bg-white/5" />
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
                            hint={
                                hasSoldEvidence
                                    ? `Median ${formatCurrency(data.analysis.comparables.median)} / m²`
                                    : "No sold comparable evidence returned"
                            }
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
                            {providerCounts.healthy}/{providerCounts.uniqueProviders || data.meta.providers.length}{" "}
                            providers responded,
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
                        ).map((provider) =>
                            (() => {
                                const providerHealth = getProviderHealth(provider);

                                return (
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
                                            <div className="text-[11px] font-mono text-slate-600">
                                                {formatFetchedAt(provider.fetchedAt)}
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-sm font-mono text-white">{provider.count}</div>
                                            <div
                                                className={cn(
                                                    "text-[11px] font-mono",
                                                    providerHealth === "error"
                                                        ? "text-red-300"
                                                        : providerHealth === "warning"
                                                          ? "text-amber-200"
                                                          : "text-green-300"
                                                )}
                                            >
                                                {providerHealth === "healthy" ? "ok" : providerHealth}
                                            </div>
                                            {provider.error ? (
                                                <div
                                                    title={provider.error}
                                                    className="mt-1 max-w-[220px] break-words text-[11px] font-mono leading-4 text-red-300"
                                                >
                                                    {summarizeProviderMessage(provider.error)}
                                                </div>
                                            ) : provider.count === 0 ? (
                                                <div className="mt-1 max-w-[220px] text-[11px] font-mono leading-4 text-amber-200">
                                                    Returned 0 rows for the current filters.
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            })()
                        )}
                    </CardContent>
                </Card>
            </div>

            <DataProvenance
                title="Overview provenance"
                provenance={data.meta.provenance?.sections.overview}
                providerSummary={data.meta.providerSummary}
            />
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

            <DataProvenance
                title="Distribution provenance"
                provenance={data.meta.provenance?.sections.priceDistribution}
                providerSummary={data.meta.providerSummary}
                compact
            />
        </div>
    );
}

export function TrendTab({ data }: AnalysisSectionProps) {
    const momentumModel = getMomentumCardModel(data);
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
                    value={momentumModel.momentumLabel}
                    hint={momentumModel.interpretation}
                    icon={Activity}
                />
                <AnalysisMetricCard
                    label="Velocity"
                    value={data.analysis.momentum ? formatSignedPercent(data.analysis.momentum.priceVelocity) : "N/A"}
                    hint={`${momentumModel.directionLabel} with ${momentumModel.confidencePercent}% confidence`}
                    icon={Sparkles}
                    valueClassName={
                        data.analysis.momentum
                            ? getSentimentTone(data.analysis.momentum.priceVelocity)
                            : "text-slate-300"
                    }
                />
            </div>

            <DataProvenance
                title="Trend provenance"
                provenance={data.meta.provenance?.sections.trend}
                providerSummary={data.meta.providerSummary}
                compact
            />
        </div>
    );
}

export function ComparablesTab({ data }: AnalysisSectionProps) {
    const activeVsSold = data.analysis.activeVsSold;
    const [dispositionFilter, setDispositionFilter] = useState<string>("all");
    const [priceBand, setPriceBand] = useState<string>("all");
    const [addressQuery, setAddressQuery] = useState("");
    const dispositions = useMemo(
        () => Array.from(new Set(data.listings.sold.map((listing) => listing.disposition).filter(Boolean))).sort(),
        [data.listings.sold]
    );
    const filteredSold = useMemo(
        () =>
            data.listings.sold.filter((listing) => {
                if (dispositionFilter !== "all" && listing.disposition !== dispositionFilter) {
                    return false;
                }

                if (priceBand !== "all") {
                    if (priceBand === "lt-80000" && listing.pricePerM2 >= 80_000) {
                        return false;
                    }

                    if (priceBand === "80000-120000" && (listing.pricePerM2 < 80_000 || listing.pricePerM2 > 120_000)) {
                        return false;
                    }

                    if (priceBand === "gt-120000" && listing.pricePerM2 <= 120_000) {
                        return false;
                    }
                }

                if (addressQuery.trim()) {
                    const haystack = `${listing.address} ${listing.disposition}`.toLowerCase();

                    if (!haystack.includes(addressQuery.trim().toLowerCase())) {
                        return false;
                    }
                }

                return true;
            }),
        [addressQuery, data.listings.sold, dispositionFilter, priceBand]
    );
    const filteredScatter = useMemo(
        () =>
            data.analysis.scatter.filter((listing) => {
                if (dispositionFilter !== "all" && listing.disposition !== dispositionFilter) {
                    return false;
                }

                if (priceBand !== "all") {
                    if (priceBand === "lt-80000" && listing.pricePerM2 >= 80_000) {
                        return false;
                    }

                    if (priceBand === "80000-120000" && (listing.pricePerM2 < 80_000 || listing.pricePerM2 > 120_000)) {
                        return false;
                    }

                    if (priceBand === "gt-120000" && listing.pricePerM2 <= 120_000) {
                        return false;
                    }
                }

                if (addressQuery.trim()) {
                    const haystack = `${listing.address} ${listing.disposition}`.toLowerCase();

                    if (!haystack.includes(addressQuery.trim().toLowerCase())) {
                        return false;
                    }
                }

                return true;
            }),
        [addressQuery, data.analysis.scatter, dispositionFilter, priceBand]
    );
    const filteredActiveSales = useMemo(
        () =>
            data.listings.activeSales.filter((listing) => {
                if (dispositionFilter !== "all" && listing.disposition !== dispositionFilter) {
                    return false;
                }

                if (priceBand !== "all") {
                    const pricePerM2 = listing.pricePerM2 ?? 0;

                    if (priceBand === "lt-80000" && pricePerM2 >= 80_000) {
                        return false;
                    }

                    if (priceBand === "80000-120000" && (pricePerM2 < 80_000 || pricePerM2 > 120_000)) {
                        return false;
                    }

                    if (priceBand === "gt-120000" && pricePerM2 <= 120_000) {
                        return false;
                    }
                }

                if (addressQuery.trim()) {
                    const haystack = `${listing.address} ${listing.disposition}`.toLowerCase();

                    if (!haystack.includes(addressQuery.trim().toLowerCase())) {
                        return false;
                    }
                }

                return true;
            }),
        [addressQuery, data.listings.activeSales, dispositionFilter, priceBand]
    );

    return (
        <div className="space-y-4">
            <SectionTitle
                title="Comparables"
                subtitle="Sold evidence, active asking context, and direct source links for every exported sale."
            />
            <Card className="border-white/5 bg-white/[0.02]">
                <CardContent className="grid gap-3 p-4 md:grid-cols-[160px_180px_minmax(0,1fr)]">
                    <Select value={dispositionFilter} onValueChange={setDispositionFilter}>
                        <SelectTrigger className="border-white/10 bg-slate-950/50 font-mono text-xs text-slate-200">
                            <SelectValue placeholder="Disposition" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All dispositions</SelectItem>
                            {dispositions.map((disposition) => (
                                <SelectItem key={disposition} value={disposition}>
                                    {disposition}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={priceBand} onValueChange={setPriceBand}>
                        <SelectTrigger className="border-white/10 bg-slate-950/50 font-mono text-xs text-slate-200">
                            <SelectValue placeholder="Price band" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All price bands</SelectItem>
                            <SelectItem value="lt-80000">&lt; 80k / m²</SelectItem>
                            <SelectItem value="80000-120000">80k - 120k / m²</SelectItem>
                            <SelectItem value="gt-120000">&gt; 120k / m²</SelectItem>
                        </SelectContent>
                    </Select>
                    <Input
                        value={addressQuery}
                        onChange={(event) => setAddressQuery(event.target.value)}
                        placeholder="Filter by address or disposition"
                        className="border-white/10 bg-slate-950/50 font-mono text-xs text-slate-200"
                    />
                </CardContent>
            </Card>
            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <ComparablesScatterChart data={{ ...data, analysis: { ...data.analysis, scatter: filteredScatter } }} />
                <ActiveSalesChart data={data} listings={filteredActiveSales} />
            </div>

            {activeVsSold ? (
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Layers3 className="h-4 w-4 text-cyan-300" />
                            Active versus sold snapshot
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            Median asking inventory spread versus realized sold pricing in the same export.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3 md:grid-cols-3">
                        <AnalysisMetricCard
                            label="Ask premium"
                            value={formatSignedPercent(activeVsSold.askingPremiumPct)}
                            hint={`${activeVsSold.activeCount} active vs ${activeVsSold.soldCount} sold rows`}
                            icon={Percent}
                            valueClassName={getSentimentTone(-activeVsSold.askingPremiumPct)}
                        />
                        <AnalysisMetricCard
                            label="Median asking / m²"
                            value={formatCurrency(activeVsSold.medianActivePricePerM2)}
                            hint={`Ratio ${activeVsSold.askingToSoldRatio?.toFixed(2) ?? "—"}x versus sold median`}
                            icon={Layers3}
                        />
                        <AnalysisMetricCard
                            label="Median sold / m²"
                            value={formatCurrency(activeVsSold.medianSoldPricePerM2)}
                            hint="REAS realized comparable pricing"
                            icon={Building2}
                        />
                    </CardContent>
                </Card>
            ) : null}

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
                            { key: "contract", header: "Contract", className: "text-slate-500" },
                            { key: "fetchedAt", header: "Fetched", className: "text-slate-500" },
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
                        rows={filteredSold.map((listing) => ({
                            address: listing.address,
                            disposition: listing.disposition,
                            area: listing.area,
                            price: listing.price,
                            pricePerM2: listing.pricePerM2,
                            link: listing.link,
                            areaLabel: `${formatInteger(listing.area)} m²`,
                            priceLabel: formatCompactCurrency(listing.price),
                            pricePerM2Label: formatCompactCurrency(listing.pricePerM2),
                            contract: listing.sourceContract ?? listing.provenance?.sourceContracts.join(", ") ?? "-",
                            fetchedAt: getPrimaryFetchedAt(listing.provenance),
                            domLabel: listing.daysOnMarket ? formatDays(listing.daysOnMarket) : "-",
                            discountLabel: listing.discount != null ? formatPercent(listing.discount) : "-",
                        }))}
                        getRowKey={(row, index) => `${String(row.address)}-${index}`}
                        emptyMessage="No sold comparables match the current filters."
                        rowClassName={(row) =>
                            typeof row.pricePerM2 === "number" &&
                            Math.abs((row.pricePerM2 - getTargetPricePerM2(data)) / getTargetPricePerM2(data)) <= 0.1
                                ? "bg-amber-500/5"
                                : undefined
                        }
                    />
                </CardContent>
            </Card>

            <DataProvenance
                title="Comparables provenance"
                provenance={data.meta.provenance?.sections.comparables}
                providerSummary={data.meta.providerSummary}
            />
        </div>
    );
}

export function RentalsTab({ data }: AnalysisSectionProps) {
    const aggregated = data.analysis.rentalAggregation ?? [];
    const dispositionYields = data.analysis.dispositionYields ?? [];
    const rentEstimation = data.analysis.rentEstimation;
    const [dispositionFilter, setDispositionFilter] = useState<string>("all");
    const [sourceFilter, setSourceFilter] = useState<string>("all");
    const [addressQuery, setAddressQuery] = useState("");
    const rentalDispositions = useMemo(
        () => Array.from(new Set(data.listings.rentals.map((listing) => listing.disposition).filter(Boolean))).sort(),
        [data.listings.rentals]
    );
    const rentalSources = useMemo(
        () => Array.from(new Set(data.listings.rentals.map((listing) => listing.source))).sort(),
        [data.listings.rentals]
    );
    const filteredRentals = useMemo(
        () =>
            data.listings.rentals.filter((listing) => {
                if (dispositionFilter !== "all" && listing.disposition !== dispositionFilter) {
                    return false;
                }

                if (sourceFilter !== "all" && listing.source !== sourceFilter) {
                    return false;
                }

                if (addressQuery.trim()) {
                    const haystack = `${listing.address} ${listing.disposition} ${listing.source}`.toLowerCase();

                    if (!haystack.includes(addressQuery.trim().toLowerCase())) {
                        return false;
                    }
                }

                return true;
            }),
        [addressQuery, data.listings.rentals, dispositionFilter, sourceFilter]
    );
    const filteredAggregated = useMemo(
        () =>
            aggregated.filter((group) => {
                if (dispositionFilter !== "all" && group.disposition !== dispositionFilter) {
                    return false;
                }

                if (sourceFilter !== "all" && !Object.keys(group.sources).includes(sourceFilter)) {
                    return false;
                }

                return true;
            }),
        [aggregated, dispositionFilter, sourceFilter]
    );

    return (
        <div className="space-y-4">
            <SectionTitle
                title="Rentals"
                subtitle="Deduplicated rental supply grouped by disposition, with provider-level evidence and raw rows."
            />
            <Card className="border-white/5 bg-white/[0.02]">
                <CardContent className="grid gap-3 p-4 md:grid-cols-[160px_180px_minmax(0,1fr)]">
                    <Select value={dispositionFilter} onValueChange={setDispositionFilter}>
                        <SelectTrigger className="border-white/10 bg-slate-950/50 font-mono text-xs text-slate-200">
                            <SelectValue placeholder="Disposition" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All dispositions</SelectItem>
                            {rentalDispositions.map((disposition) => (
                                <SelectItem key={disposition} value={disposition}>
                                    {disposition}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={sourceFilter} onValueChange={setSourceFilter}>
                        <SelectTrigger className="border-white/10 bg-slate-950/50 font-mono text-xs text-slate-200">
                            <SelectValue placeholder="Source" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All sources</SelectItem>
                            {rentalSources.map((source) => (
                                <SelectItem key={source} value={source}>
                                    {source}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Input
                        value={addressQuery}
                        onChange={(event) => setAddressQuery(event.target.value)}
                        placeholder="Filter by address, source, or disposition"
                        className="border-white/10 bg-slate-950/50 font-mono text-xs text-slate-200"
                    />
                </CardContent>
            </Card>
            <RentalAggregationChart
                data={{ ...data, analysis: { ...data.analysis, rentalAggregation: filteredAggregated } }}
                filteredDispositions={dispositionFilter === "all" ? undefined : [dispositionFilter]}
            />
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                {filteredAggregated.length > 0 ? (
                    filteredAggregated.map((group) => (
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
                                No aggregated rental rows match the current filters.
                            </InfoBox>
                        </CardContent>
                    </Card>
                )}
            </div>

            {rentEstimation ? (
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Sparkles className="h-4 w-4 text-purple-300" />
                            Rent estimation
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            Estimated rent for {data.meta.target.area} m²
                            {data.meta.target.disposition ? ` · ${data.meta.target.disposition}` : ""} based on{" "}
                            {rentEstimation.sampleSize} listings ({rentEstimation.method})
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3 md:grid-cols-3">
                        <AnalysisMetricCard
                            label="Estimated rent"
                            value={formatCompactCurrency(rentEstimation.estimatedMonthlyRent)}
                            hint={`${formatCompactCurrency(rentEstimation.confidenceRange.low)} – ${formatCompactCurrency(rentEstimation.confidenceRange.high)}`}
                            icon={Landmark}
                            valueClassName="text-purple-300"
                        />
                        <AnalysisMetricCard
                            label="Est. rent / m²"
                            value={formatCurrency(rentEstimation.estimatedRentPerM2)}
                            hint={`${rentEstimation.sampleSize} listings sampled`}
                            icon={Percent}
                        />
                        <AnalysisMetricCard
                            label="Method"
                            value={rentEstimation.method.replace(/-/g, " ")}
                            hint={
                                rentEstimation.method === "disposition-median"
                                    ? "Matched by disposition, highest confidence"
                                    : rentEstimation.method === "area-regression"
                                      ? "Cross-disposition rent/m² extrapolation"
                                      : "District-wide fallback, lower confidence"
                            }
                            icon={Activity}
                        />
                    </CardContent>
                </Card>
            ) : null}

            {dispositionYields.length > 0 ? (
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <TrendingUp className="h-4 w-4 text-emerald-300" />
                            Yield by disposition
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            Gross rental yield per disposition — cross-referencing rental medians with sold price
                            medians.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="px-0">
                        <DataTable
                            columns={[
                                { key: "disposition", header: "Disp.", className: "text-white" },
                                {
                                    key: "rentLabel",
                                    header: "Median rent/m²",
                                    align: "right",
                                    className: "text-cyan-300",
                                },
                                {
                                    key: "soldLabel",
                                    header: "Median sold/m²",
                                    align: "right",
                                    className: "text-slate-300",
                                },
                                {
                                    key: "yieldLabel",
                                    header: "Gross yield",
                                    align: "right",
                                    className: "text-emerald-300",
                                },
                                { key: "samplesLabel", header: "Samples", align: "right", className: "text-slate-500" },
                            ]}
                            rows={dispositionYields.map((row) => ({
                                disposition: row.disposition,
                                rentLabel: `${formatCurrency(row.medianRent)}/m²`,
                                soldLabel: formatCurrency(row.medianSoldPricePerM2),
                                yieldLabel: formatPercent(row.grossYieldPct),
                                samplesLabel: `${row.sampleRentals}r · ${row.sampleSold}s`,
                            }))}
                            getRowKey={(row) => String(row.disposition)}
                            emptyMessage="No cross-referenced yield data available."
                        />
                    </CardContent>
                </Card>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Landmark className="h-4 w-4 text-cyan-300" />
                            Rental listings
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="px-0">
                        <ScrollArea className="h-[560px]">
                            <DataTable
                                columns={[
                                    {
                                        key: "address",
                                        header: "Address",
                                        className: "max-w-[220px] truncate text-slate-200",
                                    },
                                    { key: "source", header: "Source", className: "text-slate-400" },
                                    { key: "disposition", header: "Disp.", className: "text-slate-400" },
                                    { key: "contract", header: "Contract", className: "text-slate-500" },
                                    { key: "fetchedAt", header: "Fetched", className: "text-slate-500" },
                                    { key: "areaLabel", header: "Area", align: "right" },
                                    { key: "rentLabel", header: "Rent", align: "right" },
                                    {
                                        key: "rentPerM2Label",
                                        header: "Rent / m²",
                                        align: "right",
                                        className: "text-cyan-300",
                                    },
                                    {
                                        key: "link",
                                        header: "Link",
                                        render: (row) =>
                                            row.link ? (
                                                <a
                                                    href={String(row.link)}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex text-slate-500 transition-colors hover:text-cyan-300"
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                </a>
                                            ) : null,
                                    },
                                ]}
                                rows={filteredRentals.map((listing) => ({
                                    address: listing.address,
                                    source: listing.source,
                                    disposition: listing.disposition,
                                    area: listing.area,
                                    rent: listing.rent,
                                    rentPerM2: listing.rentPerM2,
                                    link: listing.link,
                                    contract:
                                        listing.sourceContract ?? listing.provenance?.sourceContracts.join(", ") ?? "-",
                                    fetchedAt: getPrimaryFetchedAt(listing.provenance),
                                    areaLabel: `${formatInteger(listing.area)} m²`,
                                    rentLabel: formatCompactCurrency(listing.rent),
                                    rentPerM2Label: formatCurrency(listing.rentPerM2),
                                }))}
                                getRowKey={(row, index) => `${String(row.address)}-${index}`}
                                emptyMessage="No rental listings match the current filters."
                            />
                        </ScrollArea>
                    </CardContent>
                </Card>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-white">
                            <Landmark className="h-4 w-4 text-lime-300" />
                            MF government benchmarks
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            MF cenova mapa reference prices vs market median — government rental benchmarks per
                            cadastral unit.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {(() => {
                            const marketMedianRent =
                                aggregated.length > 0
                                    ? aggregated.reduce((sum, group) => sum + group.rentPerM2, 0) / aggregated.length
                                    : 0;

                            return data.benchmarks.mf.slice(0, 8).map((benchmark) => {
                                const diff =
                                    marketMedianRent > 0
                                        ? ((marketMedianRent - benchmark.referencePrice) / benchmark.referencePrice) *
                                          100
                                        : 0;

                                return (
                                    <div
                                        key={`${benchmark.cadastralUnit}-${benchmark.sizeCategory}`}
                                        className="rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2.5"
                                    >
                                        <div className="flex items-center justify-between gap-4">
                                            <div>
                                                <div className="text-xs font-mono text-slate-200">
                                                    {benchmark.municipality}
                                                </div>
                                                <div className="text-[11px] font-mono uppercase tracking-[0.2em] text-slate-500">
                                                    {benchmark.cadastralUnit} · {benchmark.sizeCategory}
                                                </div>
                                            </div>
                                            <div className="text-right font-mono">
                                                <div className="text-sm text-lime-300">
                                                    {formatCompactCurrency(benchmark.referencePrice)}/m²
                                                </div>
                                                <div className="text-[11px] text-slate-500">
                                                    coverage {benchmark.coverageScore}
                                                </div>
                                            </div>
                                        </div>
                                        {marketMedianRent > 0 ? (
                                            <div className="mt-2 flex items-center gap-3">
                                                <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full bg-lime-500/60"
                                                        style={{
                                                            width: `${Math.min(100, (benchmark.referencePrice / Math.max(marketMedianRent, benchmark.referencePrice)) * 100)}%`,
                                                        }}
                                                    />
                                                </div>
                                                <span
                                                    className={cn(
                                                        "text-[11px] font-mono",
                                                        diff > 0 ? "text-amber-300" : "text-emerald-300"
                                                    )}
                                                >
                                                    market {diff >= 0 ? "+" : ""}
                                                    {diff.toFixed(1)}%
                                                </span>
                                            </div>
                                        ) : null}
                                        <div className="mt-1.5 flex gap-4 text-[11px] font-mono text-slate-600">
                                            <span>
                                                conf {formatCompactCurrency(benchmark.confidenceMin)}–
                                                {formatCompactCurrency(benchmark.confidenceMax)}
                                            </span>
                                            <span>new-build {formatCompactCurrency(benchmark.newBuildPrice)}</span>
                                        </div>
                                    </div>
                                );
                            });
                        })()}
                    </CardContent>
                </Card>
            </div>

            {data.benchmarks.mf.length > 0 ? (
                <MfRentComparisonChart
                    mfBenchmarks={data.benchmarks.mf}
                    rentalAggregation={aggregated}
                    targetRentPerM2={
                        data.meta.target.area > 0 ? data.meta.target.monthlyRent / data.meta.target.area : undefined
                    }
                />
            ) : null}

            <DataProvenance
                title="Rental provenance"
                provenance={data.meta.provenance?.sections.rentals}
                providerSummary={data.meta.providerSummary}
            />
        </div>
    );
}

export function InvestmentTab({ data }: AnalysisSectionProps) {
    const scoreModel = getScoreCardModel(data);
    const targetPricePerM2 = getTargetPricePerM2(data);
    const marketPricePerM2 = data.analysis.yield.atMarketPrice.price / data.meta.target.area;
    const scenarios = getInvestmentScenarioRows(data);
    const scoreBreakdown = getScoreBreakdown(data);
    const decomposition = getInvestmentCashflowDecomposition(data);
    const projectionRows = getInvestmentProjectionRows(data);

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
                                <div className={cn("text-5xl font-black font-mono", getScoreTone(scoreModel.score))}>
                                    {scoreModel.grade}
                                </div>
                                <div className="text-sm font-mono text-slate-400">{scoreModel.recommendationLabel}</div>
                            </div>
                            <ScoreGauge score={scoreModel.score} label="Overall" />
                        </div>
                        <Progress value={scoreModel.score} className="h-2 bg-white/5" />
                        <div className="space-y-2">
                            {scoreModel.reasoning.map((item) => (
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
                        value={
                            data.analysis.yield.paybackYears != null &&
                            data.analysis.yield.atMarketPrice.paybackYears != null
                                ? `${(data.analysis.yield.atMarketPrice.paybackYears - data.analysis.yield.paybackYears).toFixed(1)}y`
                                : "—"
                        }
                        hint={
                            data.analysis.yield.paybackYears != null &&
                            data.analysis.yield.atMarketPrice.paybackYears != null
                                ? `Target ${data.analysis.yield.paybackYears.toFixed(1)}y vs market ${data.analysis.yield.atMarketPrice.paybackYears.toFixed(1)}y`
                                : "Payback data unavailable"
                        }
                        icon={Timer}
                        valueClassName={
                            data.analysis.yield.paybackYears != null &&
                            data.analysis.yield.atMarketPrice.paybackYears != null
                                ? getSentimentTone(
                                      data.analysis.yield.atMarketPrice.paybackYears - data.analysis.yield.paybackYears
                                  )
                                : undefined
                        }
                    />
                </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <InvestmentBenchmarkChart data={data} />
                <InvestmentSensitivityChart scenarios={scenarios} />
            </div>

            <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-mono text-white">Net yield decomposition</CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            Transparent walk from gross rent to current net yield.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3 sm:grid-cols-2">
                        {decomposition.map((item) => (
                            <Card key={item.label} className="border-white/5 bg-slate-950/40">
                                <CardContent className="space-y-2 p-4">
                                    <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-slate-500">
                                        {item.label}
                                    </div>
                                    <div
                                        className={cn(
                                            "text-lg font-semibold font-mono",
                                            item.valueClassName ?? "text-white"
                                        )}
                                    >
                                        {item.value}
                                    </div>
                                    <p className="text-xs font-mono leading-5 text-slate-500">{item.note}</p>
                                </CardContent>
                            </Card>
                        ))}
                    </CardContent>
                </Card>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-mono text-white">Projection ladder</CardTitle>
                        <CardDescription className="font-mono text-xs text-slate-500">
                            Simple straight-line outlook using the current annual net cashflow only.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="px-0">
                        <DataTable
                            columns={[
                                { key: "year", header: "Year", className: "text-slate-400" },
                                { key: "cumulativeRent", header: "Cum. gross rent", align: "right" },
                                { key: "cumulativeCosts", header: "Cum. costs", align: "right" },
                                {
                                    key: "cumulativeNet",
                                    header: "Cum. net cash",
                                    align: "right",
                                    className: "text-amber-200",
                                },
                                { key: "paybackShare", header: "Payback", align: "right", className: "text-cyan-300" },
                            ]}
                            rows={projectionRows.map((row) => ({
                                year: row.year,
                                cumulativeRent: row.cumulativeRent,
                                cumulativeCosts: row.cumulativeCosts,
                                cumulativeNet: row.cumulativeNet,
                                paybackShare: row.paybackShare,
                            }))}
                            getRowKey={(row) => String(row.year)}
                            emptyMessage="Projection data is unavailable."
                        />
                    </CardContent>
                </Card>
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

            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-white">Scenario sensitivity</CardTitle>
                    <CardDescription className="font-mono text-xs text-slate-500">
                        Transparent scenarios derived from the current export — no external assumptions beyond rent,
                        costs, and price deltas.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                    <DataTable
                        columns={[
                            { key: "label", header: "Scenario", className: "text-slate-200" },
                            { key: "purchasePrice", header: "Purchase", align: "right" },
                            { key: "monthlyRent", header: "Monthly rent", align: "right" },
                            { key: "monthlyCosts", header: "Monthly costs", align: "right" },
                            { key: "grossYieldLabel", header: "Gross", align: "right" },
                            { key: "netYieldLabel", header: "Net", align: "right", className: "text-amber-200" },
                            { key: "paybackLabel", header: "Payback", align: "right", className: "text-cyan-300" },
                            { key: "note", header: "Read", className: "max-w-[320px] text-slate-500" },
                        ]}
                        rows={scenarios.map((scenario) => ({
                            ...scenario,
                            purchasePrice: formatCompactCurrency(scenario.purchasePrice),
                            monthlyRent: formatCompactCurrency(scenario.monthlyRent),
                            monthlyCosts: formatCompactCurrency(scenario.monthlyCosts),
                            grossYieldLabel: formatPercent(scenario.grossYield),
                            netYieldLabel: formatPercent(scenario.netYield),
                            paybackLabel:
                                scenario.paybackYears == null || !Number.isFinite(scenario.paybackYears)
                                    ? "—"
                                    : `${scenario.paybackYears.toFixed(1)}y`,
                        }))}
                        getRowKey={(row) => String(row.label)}
                        emptyMessage="No scenarios available."
                    />
                </CardContent>
            </Card>

            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-white">Score factor audit</CardTitle>
                    <CardDescription className="font-mono text-xs text-slate-500">
                        The score translated into explicit categories before the final verdict.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
                    {scoreBreakdown.map((item) => (
                        <div key={item.label} className="rounded-xl border border-white/5 bg-slate-950/40 p-4">
                            <div className="mb-2 flex items-center justify-between gap-3 text-xs font-mono">
                                <span className="text-slate-300">{item.label}</span>
                                <span className={getScoreTone(item.score)}>{item.score}/100</span>
                            </div>
                            <Progress value={item.score} className="h-2 bg-white/5" />
                            <p className="mt-2 text-xs font-mono text-slate-500">{item.note}</p>
                        </div>
                    ))}
                </CardContent>
            </Card>

            <InfoBox
                title="Investment read"
                tone={scoreModel.score >= 65 ? "positive" : scoreModel.score >= 45 ? "info" : "warning"}
            >
                {scoreModel.reasoning.slice(0, 2).join(" ")} The current target price is{" "}
                {formatSignedPercent(data.analysis.yield.netYield - data.analysis.yield.atMarketPrice.netYield)} versus
                the market-priced case, which is the clearest immediate edge visible in this export.
            </InfoBox>

            <DataProvenance
                title="Investment provenance"
                provenance={data.meta.provenance?.sections.investment}
                providerSummary={data.meta.providerSummary}
            />
        </div>
    );
}

export function VerdictTab({ data }: AnalysisSectionProps) {
    const scoreModel = getScoreCardModel(data);
    const providerCounts = getProviderCounts(data);
    const scoreBreakdown = getScoreBreakdown(data);
    const pros = getVerdictPros(data);
    const cons = getVerdictCons(data);
    const checklist = getVerdictChecklist(data);
    const verdictLines = [
        `${scoreModel.recommendationLabel} with ${scoreModel.grade} / ${scoreModel.score} based on current sold and rental evidence.`,
        `Target pricing sits at the ${fmtPercentile(data.analysis.comparables.targetPercentile)} with ${formatPercent(data.analysis.yield.netYield)} net yield.`,
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
                                    scoreModel.score >= 65
                                        ? "border-green-500/20 bg-green-500/10 text-green-200"
                                        : scoreModel.score >= 45
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
                                {scoreModel.recommendationLabel}
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

                        <div className="grid gap-4 md:grid-cols-2">
                            <Card className="border-emerald-500/15 bg-emerald-500/[0.04]">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm font-mono text-emerald-300">Pro</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    {pros.map((item) => (
                                        <div key={item} className="text-xs font-mono text-emerald-100/80">
                                            • {item}
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                            <Card className="border-red-500/15 bg-red-500/[0.04]">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm font-mono text-red-300">Proti</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    {cons.map((item) => (
                                        <div key={item} className="text-xs font-mono text-red-100/80">
                                            • {item}
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <Card className="border-white/10 bg-slate-950/60 sm:col-span-2">
                            <CardContent className="flex flex-col items-center gap-3 p-4">
                                <ScoreGauge score={scoreModel.score} label="Conviction" />
                                <div className={cn("text-sm font-mono", getScoreTone(scoreModel.score))}>
                                    {scoreModel.grade} grade
                                </div>
                            </CardContent>
                        </Card>
                        <AnalysisMetricCard
                            label="Conviction"
                            value={`${scoreModel.score}/100`}
                            hint={`${scoreModel.grade} grade from the backend investment score`}
                            icon={ShieldCheck}
                            valueClassName={getScoreTone(scoreModel.score)}
                        />
                        <AnalysisMetricCard
                            label="Providers"
                            value={`${providerCounts.healthy}/${providerCounts.uniqueProviders || data.meta.providers.length}`}
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

            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-white">Score categories</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 lg:grid-cols-2">
                    {scoreBreakdown.map((item) => (
                        <div key={item.label} className="rounded-xl border border-white/5 bg-slate-950/40 p-4">
                            <div className="mb-2 flex items-center justify-between gap-3 text-xs font-mono">
                                <span className="text-slate-300">{item.label}</span>
                                <span className={getScoreTone(item.score)}>{item.score}/100</span>
                            </div>
                            <Progress value={item.score} className="h-2 bg-white/5" />
                            <p className="mt-2 text-xs font-mono text-slate-500">{item.note}</p>
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card className="border-white/5 bg-white/[0.02]">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-white">Pass / fail checklist</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 lg:grid-cols-2">
                    {checklist.map((item) => (
                        <div key={item.label} className="rounded-xl border border-white/5 bg-slate-950/40 p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-mono text-slate-200">{item.label}</div>
                                <Badge
                                    className={cn(
                                        "border font-mono text-[10px] uppercase tracking-[0.2em]",
                                        item.passed
                                            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                                            : "border-red-500/20 bg-red-500/10 text-red-300"
                                    )}
                                >
                                    {item.passed ? "pass" : "fail"}
                                </Badge>
                            </div>
                            <p className="mt-2 text-xs font-mono text-slate-500">{item.note}</p>
                        </div>
                    ))}
                </CardContent>
            </Card>

            <DataProvenance
                title="Verdict provenance"
                provenance={data.meta.provenance?.sections.verdict}
                providerSummary={data.meta.providerSummary}
            />
        </div>
    );
}

interface InvestmentScenarioRow {
    label: string;
    purchasePrice: number;
    monthlyRent: number;
    monthlyCosts: number;
    grossYield: number;
    netYield: number;
    paybackYears: number;
    note: string;
}

interface InvestmentDecompositionRow {
    label: string;
    value: string;
    note: string;
    valueClassName?: string;
}

interface InvestmentProjectionRow {
    year: number;
    cumulativeRent: string;
    cumulativeCosts: string;
    cumulativeNet: string;
    paybackShare: string;
}

function getInvestmentScenarioRows(data: DashboardExport): InvestmentScenarioRow[] {
    const targetNet = data.analysis.yield.netYield;
    const targetPrice = data.meta.target.price;
    const targetRent = data.meta.target.monthlyRent;
    const targetCosts = data.meta.target.monthlyCosts;

    const buildScenario = ({
        label,
        purchasePrice,
        monthlyRent,
        monthlyCosts,
        note,
    }: {
        label: string;
        purchasePrice: number;
        monthlyRent: number;
        monthlyCosts: number;
        note: string;
    }): InvestmentScenarioRow => {
        const annualRent = monthlyRent * 12;
        const annualCosts = monthlyCosts * 12;
        const grossYield = purchasePrice > 0 ? (annualRent / purchasePrice) * 100 : 0;
        const netYield = purchasePrice > 0 ? ((annualRent - annualCosts) / purchasePrice) * 100 : 0;
        const paybackYears = netYield > 0 ? 100 / netYield : Number.POSITIVE_INFINITY;

        return {
            label,
            purchasePrice,
            monthlyRent,
            monthlyCosts,
            grossYield,
            netYield,
            paybackYears,
            note,
        };
    };

    return [
        buildScenario({
            label: "Target snapshot",
            purchasePrice: targetPrice,
            monthlyRent: targetRent,
            monthlyCosts: targetCosts,
            note: "Current target purchase and rent inputs.",
        }),
        buildScenario({
            label: "Market pricing",
            purchasePrice: data.analysis.yield.atMarketPrice.price,
            monthlyRent: targetRent,
            monthlyCosts: targetCosts,
            note: "Same rent profile, but bought at the current market-priced case.",
        }),
        buildScenario({
            label: "Rent -10%",
            purchasePrice: targetPrice,
            monthlyRent: targetRent * 0.9,
            monthlyCosts: targetCosts,
            note: "Stress test for softer leasing conditions.",
        }),
        buildScenario({
            label: "Rent +10%",
            purchasePrice: targetPrice,
            monthlyRent: targetRent * 1.1,
            monthlyCosts: targetCosts,
            note: "Upside case if leasing clears above the current target rent.",
        }),
        buildScenario({
            label: "Costs +10%",
            purchasePrice: targetPrice,
            monthlyRent: targetRent,
            monthlyCosts: targetCosts * 1.1,
            note: "Operating-cost stress without changing the rent assumption.",
        }),
        buildScenario({
            label: "Yield neutral price",
            purchasePrice:
                targetNet > 0 ? ((targetRent * 12 - targetCosts * 12) / (targetNet / 100)) * 1.05 : targetPrice,
            monthlyRent: targetRent,
            monthlyCosts: targetCosts,
            note: "Illustrates how a 5% richer purchase price compresses the same income stream.",
        }),
    ];
}

function getInvestmentCashflowDecomposition(data: DashboardExport): InvestmentDecompositionRow[] {
    const annualGrossRent = data.meta.target.monthlyRent * 12;
    const annualCosts = data.meta.target.monthlyCosts * 12;
    const annualNetCashflow = annualGrossRent - annualCosts;
    const marketPriceGap = data.analysis.yield.atMarketPrice.price - data.meta.target.price;

    return [
        {
            label: "Annual gross rent",
            value: formatCompactCurrency(annualGrossRent),
            note: `${formatCompactCurrency(data.meta.target.monthlyRent)} per month from the current target rent.`,
        },
        {
            label: "Annual costs",
            value: formatCompactCurrency(annualCosts),
            note: `${formatCompactCurrency(data.meta.target.monthlyCosts)} per month deducted before net yield.`,
            valueClassName: "text-red-300",
        },
        {
            label: "Annual net cash",
            value: formatCompactCurrency(annualNetCashflow),
            note: `${formatPercent(data.analysis.yield.netYield)} net yield on ${formatCompactCurrency(data.meta.target.price)} purchase price.`,
            valueClassName: getSentimentTone(annualNetCashflow),
        },
        {
            label: "Market price gap",
            value: formatCompactCurrency(marketPriceGap),
            note: `${formatSignedPercent(data.analysis.yield.netYield - data.analysis.yield.atMarketPrice.netYield)} net-yield edge versus the market-priced case.`,
            valueClassName: getSentimentTone(-marketPriceGap),
        },
    ];
}

function getInvestmentProjectionRows(data: DashboardExport): InvestmentProjectionRow[] {
    const annualGrossRent = data.meta.target.monthlyRent * 12;
    const annualCosts = data.meta.target.monthlyCosts * 12;
    const annualNetCashflow = annualGrossRent - annualCosts;

    return Array.from({ length: 5 }, (_, index) => {
        const year = index + 1;
        const cumulativeRent = annualGrossRent * year;
        const cumulativeCosts = annualCosts * year;
        const cumulativeNet = annualNetCashflow * year;
        const paybackShare = data.meta.target.price > 0 ? (cumulativeNet / data.meta.target.price) * 100 : 0;

        return {
            year,
            cumulativeRent: formatCompactCurrency(cumulativeRent),
            cumulativeCosts: formatCompactCurrency(cumulativeCosts),
            cumulativeNet: formatCompactCurrency(cumulativeNet),
            paybackShare: formatPercent(paybackShare),
        };
    });
}

function getScoreBreakdown(data: DashboardExport) {
    const factors = data.analysis.investmentScore?.factors;

    if (factors) {
        return [
            { label: "Yield", score: factors.yieldScore, note: "Net yield versus benchmark hurdle." },
            { label: "Discount", score: factors.discountScore, note: "How attractive the entry price looks." },
            { label: "Trend", score: factors.trendScore, note: "Direction and YoY pricing support." },
            {
                label: "Velocity",
                score: factors.marketVelocityScore,
                note: "Absorption speed and liquidity in the local market.",
            },
        ];
    }

    return [
        {
            label: "Pricing",
            score: Math.max(0, Math.min(100, 100 - data.analysis.comparables.targetPercentile)),
            note: "Fallback score from target percentile versus sold comps.",
        },
        {
            label: "Yield",
            score: Math.max(0, Math.min(100, data.analysis.yield.netYield * 20)),
            note: "Fallback score from current net yield.",
        },
    ];
}

function getVerdictPros(data: DashboardExport) {
    const pros: string[] = [];

    if (data.analysis.comparables.targetPercentile <= 40) {
        pros.push(
            `Entry price sits at the ${formatPercentile(data.analysis.comparables.targetPercentile)} of sold comps.`
        );
    }

    if (data.analysis.yield.netYield >= data.analysis.yield.atMarketPrice.netYield) {
        pros.push(
            `Target net yield beats the market-priced case by ${formatSignedPercent(data.analysis.yield.netYield - data.analysis.yield.atMarketPrice.netYield)}.`
        );
    }

    if (data.listings.rentals.length >= 20) {
        pros.push(`Rental read is backed by ${data.listings.rentals.length} listings across multiple providers.`);
    }

    if (data.analysis.momentum?.direction === "rising") {
        pros.push(`Momentum still reads as rising (${data.analysis.momentum.confidence} confidence).`);
    }

    return pros.length > 0 ? pros : ["No strong upside factors were returned beyond the baseline recommendation."];
}

function getVerdictCons(data: DashboardExport) {
    const cons: string[] = [];

    if (data.analysis.comparables.targetPercentile >= 60) {
        cons.push(
            `Target price is already above the market midpoint at the ${formatPercentile(data.analysis.comparables.targetPercentile)}.`
        );
    }

    if (data.analysis.yield.netYield < 3.5) {
        cons.push(`Net yield remains thin at ${formatPercent(data.analysis.yield.netYield)}.`);
    }

    if (data.analysis.timeOnMarket.median > 90) {
        cons.push(`Liquidity is slower than ideal with ${formatDays(data.analysis.timeOnMarket.median)} median DOM.`);
    }

    if (data.analysis.momentum?.direction === "declining") {
        cons.push(`Momentum has rolled over: ${data.analysis.momentum.interpretation}`);
    }

    return cons.length > 0 ? cons : ["No material red flags surfaced from the current export."];
}

function getVerdictChecklist(data: DashboardExport) {
    return [
        {
            label: "Price below median band",
            passed: data.analysis.comparables.targetPercentile <= 50,
            note: `Current position: ${formatPercentile(data.analysis.comparables.targetPercentile)} of sold comps.`,
        },
        {
            label: "Net yield clears Prague baseline",
            passed: data.analysis.yield.netYield >= 3.5,
            note: `Current net yield: ${formatPercent(data.analysis.yield.netYield)}.`,
        },
        {
            label: "Sufficient sold evidence",
            passed: data.analysis.comparables.count >= 10,
            note: `${data.analysis.comparables.count} sold comparables in the export.`,
        },
        {
            label: "Sufficient rental evidence",
            passed: data.listings.rentals.length >= 10,
            note: `${data.listings.rentals.length} rental listings in the export.`,
        },
    ];
}
