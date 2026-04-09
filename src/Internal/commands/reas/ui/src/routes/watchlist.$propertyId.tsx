import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import type { PropertyAnalysisHistoryRow, SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { toast } from "@ui/index";
import { cn } from "@ui/lib/utils";
import { ArrowLeft, ExternalLink, FileStack, History, Layers3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DataTable } from "../components/analysis/DataTable";
import { InfoBox } from "../components/analysis/InfoBox";
import { ScoreGauge } from "../components/analysis/ScoreGauge";
import { SectionTitle } from "../components/analysis/SectionTitle";
import { StatCard } from "../components/analysis/StatCard";
import { ComparablesTable } from "../components/ComparablesTable";
import { MomentumCard } from "../components/MomentumCard";
import { PriceTrendChart } from "../components/PriceTrendChart";
import { ScoreCard } from "../components/ScoreCard";
import { PropertyHistoryChart } from "../components/watchlist/PropertyHistoryChart";
import { PropertyMortgageCard } from "../components/watchlist/PropertyMortgageCard";
import { PropertyVerdictMini } from "../components/watchlist/PropertyVerdictMini";
import { PropertyYieldBreakdown } from "../components/watchlist/PropertyYieldBreakdown";
import { ProviderLinks } from "../components/watchlist/ProviderLinks";
import { buildPropertyCardModel } from "../components/watchlist/property-card-model";
import {
    formatConstructionType,
    formatCurrencyCompact,
    formatCurrencyFull,
    formatDateShort,
    formatDateTime,
    formatDisposition,
    formatNumber,
    formatYield,
    GRADE_COLORS,
    getStalenessInfo,
    PROVIDER_BADGE_STYLES,
    PROVIDER_LABELS,
    parseSavedProviders,
} from "../components/watchlist/watchlist-utils";
import { YieldCard } from "../components/YieldCard";

export const Route = createFileRoute("/watchlist/$propertyId")({
    component: WatchlistPropertyDetailPage,
});

interface PropertyDetailResponse {
    property: SavedPropertyRow;
    history: PropertyAnalysisHistoryRow[];
    analysis: FullAnalysis | null;
    exportData: DashboardExport | null;
}

interface PropertyHistoryResponse {
    history: PropertyAnalysisHistoryRow[];
}

const DETAIL_METRIC_SKELETON_KEYS = ["one", "two", "three", "four"] as const;
const HISTORY_ROW_SKELETON_KEYS = ["row-a", "row-b", "row-c", "row-d", "row-e"] as const;

function usePropertyDetail(propertyId: number) {
    return useQuery<PropertyDetailResponse>({
        queryKey: ["property-detail", propertyId],
        queryFn: async () => {
            const res = await fetch(`/api/property-detail?id=${propertyId}`);

            if (!res.ok) {
                throw new Error("Failed to fetch property detail");
            }

            return res.json();
        },
        enabled: Number.isFinite(propertyId),
    });
}

function usePropertyHistory(propertyId: number) {
    return useQuery<PropertyHistoryResponse>({
        queryKey: ["property-history", propertyId],
        queryFn: async () => {
            const res = await fetch(`/api/properties/${propertyId}/history?limit=50`);

            if (!res.ok) {
                throw new Error("Failed to fetch property history");
            }

            return res.json();
        },
        enabled: Number.isFinite(propertyId),
    });
}

function WatchlistPropertyDetailPage() {
    const params = Route.useParams();
    const propertyId = Number(params.propertyId);
    const queryClient = useQueryClient();
    const detailQuery = usePropertyDetail(propertyId);
    const historyQuery = usePropertyHistory(propertyId);
    const [alertYieldFloor, setAlertYieldFloor] = useState("");
    const [alertGradeChange, setAlertGradeChange] = useState(false);

    const property = detailQuery.data?.property;
    const exportData = detailQuery.data?.exportData ?? null;
    const history = historyQuery.data?.history ?? detailQuery.data?.history ?? [];
    const propertyModel = useMemo(() => {
        if (!property) {
            return null;
        }

        return buildPropertyCardModel(property);
    }, [property]);

    useEffect(() => {
        if (!property) {
            return;
        }

        setAlertYieldFloor(property.alert_yield_floor != null ? String(property.alert_yield_floor) : "");
        setAlertGradeChange(property.alert_grade_change === 1);
    }, [property]);

    const updateAlertsMutation = useMutation({
        mutationFn: async () => {
            const response = await fetch(`/api/properties?id=${propertyId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify({
                    action: "update-settings",
                    alertYieldFloor: alertYieldFloor.trim() ? Number(alertYieldFloor) : null,
                    alertGradeChange,
                }),
            });

            const body = (await response.json()) as { error?: string };

            if (!response.ok) {
                throw new Error(body.error ?? "Failed to update alert settings");
            }
        },
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["properties"] }),
                queryClient.invalidateQueries({ queryKey: ["property-detail", propertyId] }),
            ]);
            toast.success("Alert settings updated");
        },
        onError: (error: Error) => {
            toast.error(error.message);
        },
    });

    const historySeries = useMemo(() => {
        const ordered = [...history].reverse();

        return {
            score: ordered
                .filter((entry) => entry.score != null)
                .map((entry) => ({ label: formatDateShort(entry.analyzed_at), value: entry.score ?? 0 })),
            netYield: ordered
                .filter((entry) => entry.net_yield != null)
                .map((entry) => ({ label: formatDateShort(entry.analyzed_at), value: entry.net_yield ?? 0 })),
            medianPrice: ordered
                .filter((entry) => entry.median_price_per_m2 != null)
                .map((entry) => ({ label: formatDateShort(entry.analyzed_at), value: entry.median_price_per_m2 ?? 0 })),
        };
    }, [history]);

    if (detailQuery.isLoading) {
        return (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-4">
                <Skeleton variant="default" className="h-10 w-40" />
                <Skeleton variant="default" className="h-28 w-full" />
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                    {DETAIL_METRIC_SKELETON_KEYS.map((key) => (
                        <Skeleton key={key} variant="default" className="h-28 w-full" />
                    ))}
                </div>
                <Skeleton variant="default" className="h-[360px] w-full" />
            </div>
        );
    }

    if (detailQuery.error || !property) {
        return (
            <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
                <Card className="border-red-500/20 bg-red-500/5">
                    <CardContent className="py-8 text-center space-y-3">
                        <p className="text-sm font-mono text-red-400">Property detail could not be loaded.</p>
                        <Button asChild variant="outline" className="font-mono text-xs border-white/10 text-gray-300">
                            <Link to="/watchlist">
                                <ArrowLeft className="h-3.5 w-3.5" />
                                Back to Watchlist
                            </Link>
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    const staleness = getStalenessInfo(property.last_analyzed_at);
    const gradeStyle = property.last_grade ? (GRADE_COLORS[property.last_grade] ?? "") : "";
    const providers = parseSavedProviders(property.providers);
    const alertYieldTriggered =
        property.alert_yield_floor != null &&
        property.last_net_yield != null &&
        property.last_net_yield < property.alert_yield_floor;

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
            <div className="flex flex-col gap-4">
                <Button asChild variant="outline" className="w-fit font-mono text-xs border-white/10 text-gray-300">
                    <Link to="/watchlist">
                        <ArrowLeft className="h-3.5 w-3.5" />
                        Back to Watchlist
                    </Link>
                </Button>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardContent className="py-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h1 className="text-2xl font-mono font-bold text-gray-100">{property.name}</h1>
                                {property.last_grade && (
                                    <Badge variant="outline" className={cn("text-xs font-mono font-bold", gradeStyle)}>
                                        Grade {property.last_grade}
                                    </Badge>
                                )}
                                <Badge variant="outline" className={cn("text-[10px] font-mono", staleness.color)}>
                                    {staleness.label}
                                </Badge>
                            </div>
                            <p className="text-sm font-mono text-gray-400">
                                {property.district} · {formatConstructionType(property.construction_type)} ·{" "}
                                {formatDisposition(property.disposition)}
                            </p>
                            <div className="flex flex-wrap gap-2 text-[10px] font-mono text-gray-500">
                                <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                                    Added {formatDateTime(property.created_at)}
                                </Badge>
                                <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                                    Last analyzed {formatDateTime(property.last_analyzed_at)}
                                </Badge>
                                {providers.map((provider) => (
                                    <Badge
                                        key={provider}
                                        variant="outline"
                                        className={cn(
                                            "border-white/10 bg-white/[0.02] text-[10px] font-mono",
                                            PROVIDER_BADGE_STYLES[provider] ?? "text-gray-400"
                                        )}
                                    >
                                        {PROVIDER_LABELS[provider] ?? provider}
                                    </Badge>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2 text-xs font-mono lg:text-right">
                            <div className="text-gray-500">Listing URL</div>
                            {property.listing_url ? (
                                <a
                                    href={property.listing_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300"
                                >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    <span className="max-w-[24rem] truncate">{property.listing_url}</span>
                                </a>
                            ) : (
                                <p className="text-gray-400">No listing URL stored</p>
                            )}
                            {property.notes && (
                                <p className="max-w-[30rem] text-gray-500 lg:ml-auto">{property.notes}</p>
                            )}
                        </div>
                    </CardContent>
                </Card>

                <ProviderLinks district={property.district} listingUrl={property.listing_url} providers={providers} />

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                    <StatCard label="Net Yield" value={formatYield(property.last_net_yield)} accent="cyan" />
                    <StatCard label="Score" value={formatNumber(property.last_score)} accent="amber" />
                    <StatCard
                        label="Median CZK/m2"
                        value={formatCurrencyCompact(property.last_median_price_per_m2)}
                        accent="slate"
                    />
                    <StatCard label="Comparable Count" value={formatNumber(property.comparable_count)} accent="green" />
                </div>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-mono text-amber-400">Alert Settings</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                            <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                                Current yield {formatYield(property.last_net_yield)}
                            </Badge>
                            {property.alert_yield_floor != null ? (
                                <Badge
                                    variant="outline"
                                    className={cn(
                                        "bg-white/[0.02]",
                                        alertYieldTriggered
                                            ? "border-rose-500/30 text-rose-300"
                                            : "border-amber-500/20 text-amber-300"
                                    )}
                                >
                                    Floor {property.alert_yield_floor.toFixed(1)}%
                                </Badge>
                            ) : (
                                <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-500">
                                    No yield floor set
                                </Badge>
                            )}
                            <Badge
                                variant="outline"
                                className={cn(
                                    "bg-white/[0.02]",
                                    property.alert_grade_change
                                        ? "border-amber-500/20 text-amber-300"
                                        : "border-white/10 text-gray-500"
                                )}
                            >
                                Grade change {property.alert_grade_change ? "enabled" : "off"}
                            </Badge>
                        </div>

                        <div className="grid gap-3 md:grid-cols-[minmax(0,220px)_1fr]">
                            <div>
                                <label
                                    htmlFor="detail-alert-yield"
                                    className="mb-1 block text-[10px] font-mono text-gray-500"
                                >
                                    Yield floor (%)
                                </label>
                                <Input
                                    id="detail-alert-yield"
                                    type="number"
                                    value={alertYieldFloor}
                                    onChange={(event) => setAlertYieldFloor(event.target.value)}
                                    placeholder="4.5"
                                    className="h-8 border-white/10 bg-black/20 text-xs font-mono"
                                />
                            </div>

                            <label className="flex items-center gap-2 rounded border border-white/10 bg-black/20 px-3 py-2 text-[11px] font-mono text-gray-300 md:self-end">
                                <Checkbox
                                    id="detail-alert-grade"
                                    checked={alertGradeChange}
                                    onCheckedChange={(checked) => setAlertGradeChange(checked === true)}
                                />
                                <span>Alert when the investment grade changes</span>
                            </label>
                        </div>

                        <div className="flex justify-end">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => updateAlertsMutation.mutate()}
                                disabled={updateAlertsMutation.isPending}
                                className="border-amber-500/30 text-amber-300 hover:bg-amber-500/10 font-mono text-xs"
                            >
                                {updateAlertsMutation.isPending ? "Saving..." : "Save Alerts"}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <Tabs defaultValue="overview">
                <TabsList className="bg-black/30 border-white/10">
                    <TabsTrigger value="overview" className="font-mono text-xs">
                        <Layers3 className="h-3.5 w-3.5" />
                        Overview
                    </TabsTrigger>
                    <TabsTrigger value="comparables" className="font-mono text-xs">
                        <History className="h-3.5 w-3.5" />
                        Comparables
                    </TabsTrigger>
                    <TabsTrigger value="rentals" className="font-mono text-xs">
                        <FileStack className="h-3.5 w-3.5" />
                        Rentals
                    </TabsTrigger>
                    <TabsTrigger value="investment" className="font-mono text-xs">
                        <FileStack className="h-3.5 w-3.5" />
                        Investment
                    </TabsTrigger>
                    <TabsTrigger value="verdict" className="font-mono text-xs">
                        <FileStack className="h-3.5 w-3.5" />
                        Verdict
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4">
                    {exportData ? (
                        <>
                            <SectionTitle
                                title="Overview"
                                subtitle="Stored property snapshot, current pricing signal, and the latest trend history."
                            />

                            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                                <Card className="border-white/5 bg-white/[0.02]">
                                    <CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
                                        <div className="space-y-3">
                                            <div className="text-xs font-mono uppercase tracking-[0.24em] text-slate-500">
                                                Snapshot verdict
                                            </div>
                                            <div className="text-2xl font-mono font-semibold text-white">
                                                {property.last_grade ? `Grade ${property.last_grade}` : "No grade yet"}
                                            </div>
                                            <InfoBox tone={alertYieldTriggered ? "warning" : "info"}>
                                                {alertYieldTriggered
                                                    ? `Yield is below the configured floor of ${property.alert_yield_floor?.toFixed(1)}%.`
                                                    : `Latest analysis uses ${providers.length} configured providers and ${history.length} stored snapshots.`}
                                            </InfoBox>
                                        </div>
                                        <ScoreGauge score={property.last_score ?? 0} label="Stored score" />
                                    </CardContent>
                                </Card>

                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    <StatCard
                                        label="Purchase Price"
                                        value={formatCurrencyFull(property.target_price)}
                                        hint={`${formatNumber(property.target_area)} m2 · ${formatDisposition(property.disposition)}`}
                                        accent="amber"
                                    />
                                    <StatCard
                                        label="Monthly Rent"
                                        value={formatCurrencyFull(property.monthly_rent)}
                                        hint={`Costs ${formatCurrencyFull(property.monthly_costs)}`}
                                        accent="cyan"
                                    />
                                    <StatCard
                                        label="Percentile"
                                        value={
                                            property.percentile != null ? `${property.percentile.toFixed(0)}th` : "-"
                                        }
                                        hint="Relative to sold comparables"
                                        accent="green"
                                    />
                                    <StatCard
                                        label="Momentum"
                                        value={property.momentum ?? "-"}
                                        hint={`Last analyzed ${formatDateTime(property.last_analyzed_at)}`}
                                        accent="purple"
                                    />
                                </div>
                            </div>

                            <PriceTrendChart data={exportData} />

                            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                                <PropertyHistoryChart
                                    title="Score History"
                                    color="rgb(245 158 11)"
                                    points={historySeries.score}
                                />
                                <PropertyHistoryChart
                                    title="Net Yield History"
                                    color="rgb(6 182 212)"
                                    valueSuffix="%"
                                    points={historySeries.netYield}
                                />
                                <PropertyHistoryChart
                                    title="Median Price History"
                                    color="rgb(16 185 129)"
                                    points={historySeries.medianPrice}
                                />
                            </div>
                        </>
                    ) : (
                        <Card className="border-white/5 bg-white/[0.02]">
                            <CardContent className="py-10 text-center">
                                <p className="text-sm font-mono text-gray-400">
                                    This property does not have stored export data yet.
                                </p>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                <TabsContent value="comparables" className="space-y-4">
                    {exportData ? (
                        <>
                            <SectionTitle
                                title="Comparables"
                                subtitle="Stored sold-market evidence and pricing context used for this property snapshot."
                            />
                            <ComparablesTable data={exportData} />
                        </>
                    ) : (
                        <Card className="border-white/5 bg-white/[0.02]">
                            <CardContent className="py-10 text-center">
                                <p className="text-sm font-mono text-gray-400">No sold comparables are stored yet.</p>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                <TabsContent value="rentals" className="space-y-4">
                    {exportData ? (
                        <>
                            <SectionTitle
                                title="Rentals"
                                subtitle="Stored rental rows and MF benchmark context from the latest export."
                            />

                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                <StatCard
                                    label="Target Price"
                                    value={formatCurrencyFull(exportData.meta.target.price)}
                                    accent="amber"
                                />
                                <StatCard
                                    label="Target Area"
                                    value={`${formatNumber(exportData.meta.target.area)} m2`}
                                    accent="slate"
                                />
                                <StatCard
                                    label="Providers"
                                    value={formatNumber(exportData.meta.providers.length)}
                                    accent="cyan"
                                />
                                <StatCard
                                    label="Generated"
                                    value={formatDateTime(exportData.meta.generatedAt)}
                                    accent="green"
                                />
                            </div>

                            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                <Card className="border-white/5 bg-white/[0.02]">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm font-mono text-amber-400">
                                            Stored Rental Listings
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="px-0">
                                        <DataTable
                                            columns={[
                                                {
                                                    key: "address",
                                                    header: "Address",
                                                    className: "max-w-[260px] truncate text-gray-300",
                                                },
                                                { key: "rentLabel", header: "Rent", align: "right" },
                                                {
                                                    key: "rentPerM2Label",
                                                    header: "CZK/m2",
                                                    align: "right",
                                                    className: "text-cyan-400",
                                                },
                                            ]}
                                            rows={exportData.listings.rentals
                                                .slice(0, 12)
                                                .map(({ provenance: _p, ...listing }) => ({
                                                    ...listing,
                                                    rentLabel: formatCurrencyCompact(listing.rent),
                                                    rentPerM2Label: formatCurrencyCompact(listing.rentPerM2),
                                                }))}
                                            getRowKey={(row, index) => `${String(row.address)}-${index}`}
                                            emptyMessage="No rental rows stored in this export."
                                        />
                                    </CardContent>
                                </Card>

                                <Card className="border-white/5 bg-white/[0.02]">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm font-mono text-amber-400">
                                            Yield Context
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-4">
                                        <YieldCard data={exportData} />
                                    </CardContent>
                                </Card>
                            </div>
                        </>
                    ) : (
                        <Card className="border-white/5 bg-white/[0.02]">
                            <CardContent className="py-10 text-center">
                                <p className="text-sm font-mono text-gray-400">
                                    No stored export payload is available for this property.
                                </p>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                <TabsContent value="investment" className="space-y-4">
                    <SectionTitle
                        title="Investment"
                        subtitle="Financing impact, yield breakdown, and the current score stack for this property."
                    />
                    <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-4">
                        <Card className="border-white/5 bg-white/[0.02]">
                            <CardContent className="grid gap-4 p-5 md:grid-cols-[0.8fr_1.2fr] md:items-center">
                                <ScoreGauge score={property.last_score ?? 0} label="Stored score" />
                                <div className="space-y-3">
                                    <InfoBox tone="info" title="Stored snapshot">
                                        Net yield {formatYield(property.last_net_yield)} · gross yield{" "}
                                        {formatYield(property.last_gross_yield)} · market median{" "}
                                        {formatCurrencyCompact(property.last_median_price_per_m2)}.
                                    </InfoBox>
                                    {exportData ? <MomentumCard data={exportData} /> : null}
                                </div>
                            </CardContent>
                        </Card>

                        {propertyModel ? <PropertyYieldBreakdown model={propertyModel} /> : null}
                    </div>

                    <PropertyMortgageCard mortgage={propertyModel?.mortgage ?? null} />
                </TabsContent>

                <TabsContent value="verdict" className="space-y-4">
                    <SectionTitle
                        title="Verdict"
                        subtitle="Recommendation, provider provenance, and the stored history snapshots behind the latest score."
                    />

                    {propertyModel ? (
                        <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.05fr] gap-4">
                            <PropertyVerdictMini grade={property.last_grade} model={propertyModel} />
                            <div className="space-y-4">
                                <InfoBox
                                    tone={
                                        property.last_grade === "A" || property.last_grade === "B"
                                            ? "positive"
                                            : "warning"
                                    }
                                    title="Recommendation"
                                >
                                    {propertyModel.recommendation
                                        ? `${propertyModel.recommendation} backed by ${propertyModel.reasons.length} stored reasons and ${propertyModel.verdictChecklist.length} checklist items.`
                                        : "No stored recommendation is available yet. Refresh the property to generate one."}
                                </InfoBox>
                                {exportData ? <ScoreCard data={exportData} /> : null}
                            </div>
                        </div>
                    ) : (
                        <InfoBox tone="warning" title="Stored analysis">
                            This property does not have stored analysis details yet. Refresh it to populate a verdict.
                        </InfoBox>
                    )}

                    <Card className="border-white/5 bg-white/[0.02]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-mono text-amber-400">Provider Fetch Summary</CardTitle>
                        </CardHeader>
                        <CardContent className="px-0">
                            {exportData?.meta.providerSummary && exportData.meta.providerSummary.length > 0 ? (
                                <DataTable
                                    columns={[
                                        { key: "provider", header: "Provider", className: "text-gray-300" },
                                        { key: "sourceContract", header: "Contract", className: "text-gray-500" },
                                        {
                                            key: "countLabel",
                                            header: "Count",
                                            align: "right",
                                            className: "text-cyan-400",
                                        },
                                        { key: "fetchedLabel", header: "Fetched", className: "text-gray-500" },
                                    ]}
                                    rows={exportData.meta.providerSummary.map((provider) => ({
                                        ...provider,
                                        countLabel: formatNumber(provider.count),
                                        fetchedLabel: formatDateTime(provider.fetchedAt),
                                    }))}
                                    getRowKey={(row) => `${String(row.provider)}-${String(row.sourceContract)}`}
                                />
                            ) : (
                                <p className="px-6 pb-6 text-xs font-mono text-gray-500">No provider summary stored.</p>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="border-white/5 bg-white/[0.02]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-mono text-amber-400">Analysis Snapshots</CardTitle>
                        </CardHeader>
                        <CardContent className="px-0">
                            {historyQuery.isLoading ? (
                                <div className="px-6 pb-6 space-y-2">
                                    {HISTORY_ROW_SKELETON_KEYS.map((key) => (
                                        <Skeleton key={key} variant="default" className="h-8 w-full" />
                                    ))}
                                </div>
                            ) : history.length > 0 ? (
                                <DataTable
                                    columns={[
                                        { key: "analyzedLabel", header: "Analyzed", className: "text-gray-400" },
                                        {
                                            key: "gradeLabel",
                                            header: "Grade",
                                            render: (row) =>
                                                row.grade ? (
                                                    <Badge
                                                        variant="outline"
                                                        className={cn(
                                                            "text-[10px] font-mono",
                                                            GRADE_COLORS[String(row.grade)] ??
                                                                "border-white/10 text-gray-400"
                                                        )}
                                                    >
                                                        {row.gradeLabel}
                                                    </Badge>
                                                ) : (
                                                    <span className="text-xs font-mono text-gray-500">-</span>
                                                ),
                                        },
                                        {
                                            key: "scoreLabel",
                                            header: "Score",
                                            align: "right",
                                            className: "text-amber-400",
                                        },
                                        {
                                            key: "netYieldLabel",
                                            header: "Net Yield",
                                            align: "right",
                                            className: "text-cyan-400",
                                        },
                                        { key: "grossYieldLabel", header: "Gross Yield", align: "right" },
                                        { key: "medianLabel", header: "Median CZK/m2", align: "right" },
                                        {
                                            key: "compsLabel",
                                            header: "Comps",
                                            align: "right",
                                            className: "text-gray-400",
                                        },
                                    ]}
                                    rows={history.map((entry) => ({
                                        ...entry,
                                        analyzedLabel: formatDateTime(entry.analyzed_at),
                                        gradeLabel: entry.grade ?? "-",
                                        scoreLabel: formatNumber(entry.score),
                                        netYieldLabel: formatYield(entry.net_yield),
                                        grossYieldLabel: formatYield(entry.gross_yield),
                                        medianLabel: formatCurrencyCompact(entry.median_price_per_m2),
                                        compsLabel: formatNumber(entry.comparable_count),
                                    }))}
                                    getRowKey={(row) => String(row.id)}
                                />
                            ) : (
                                <div className="px-6 pb-6">
                                    <p className="text-xs font-mono text-gray-500">
                                        No analysis history is stored for this property yet.
                                    </p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
