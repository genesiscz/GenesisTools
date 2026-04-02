import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import type { PropertyAnalysisHistoryRow, SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import type { FullAnalysis } from "@app/Internal/commands/reas/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib/utils";
import { ArrowLeft, ExternalLink, FileStack, History, Layers3 } from "lucide-react";
import { useMemo } from "react";
import { ComparablesTable } from "../components/ComparablesTable";
import { MomentumCard } from "../components/MomentumCard";
import { PriceTrendChart } from "../components/PriceTrendChart";
import { ScoreCard } from "../components/ScoreCard";
import { PropertyHistoryChart } from "../components/watchlist/PropertyHistoryChart";
import { ProviderLinks } from "../components/watchlist/ProviderLinks";
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

interface DetailMetricProps {
    label: string;
    value: string;
    tone?: "default" | "accent" | "warning";
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

function DetailMetric({ label, value, tone = "default" }: DetailMetricProps) {
    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-[10px] font-mono uppercase tracking-[0.18em] text-gray-600">
                    {label}
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div
                    className={cn(
                        "text-2xl font-mono font-bold",
                        tone === "accent" && "text-cyan-400",
                        tone === "warning" && "text-amber-400",
                        tone === "default" && "text-gray-100"
                    )}
                >
                    {value}
                </div>
            </CardContent>
        </Card>
    );
}

function WatchlistPropertyDetailPage() {
    const params = Route.useParams();
    const propertyId = Number(params.propertyId);
    const detailQuery = usePropertyDetail(propertyId);
    const historyQuery = usePropertyHistory(propertyId);

    const property = detailQuery.data?.property;
    const exportData = detailQuery.data?.exportData ?? null;
    const history = historyQuery.data?.history ?? detailQuery.data?.history ?? [];

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
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-4">
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

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
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
                    <DetailMetric label="Net Yield" value={formatYield(property.last_net_yield)} tone="accent" />
                    <DetailMetric label="Score" value={formatNumber(property.last_score)} tone="warning" />
                    <DetailMetric
                        label="Median CZK/m2"
                        value={formatCurrencyCompact(property.last_median_price_per_m2)}
                    />
                    <DetailMetric label="Comparable Count" value={formatNumber(property.comparable_count)} />
                </div>
            </div>

            <Tabs defaultValue="overview">
                <TabsList className="bg-black/30 border-white/10">
                    <TabsTrigger value="overview" className="font-mono text-xs">
                        <Layers3 className="h-3.5 w-3.5" />
                        Overview
                    </TabsTrigger>
                    <TabsTrigger value="history" className="font-mono text-xs">
                        <History className="h-3.5 w-3.5" />
                        History
                    </TabsTrigger>
                    <TabsTrigger value="export" className="font-mono text-xs">
                        <FileStack className="h-3.5 w-3.5" />
                        Stored Export
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4">
                    {exportData ? (
                        <>
                            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                                <ScoreCard data={exportData} />
                                <YieldCard data={exportData} />
                                <MomentumCard data={exportData} />
                            </div>

                            <PriceTrendChart data={exportData} />
                            <ComparablesTable data={exportData} />
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

                <TabsContent value="history" className="space-y-4">
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
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow className="border-white/5 hover:bg-transparent">
                                                <TableHead className="text-[10px] font-mono text-gray-500">
                                                    Analyzed
                                                </TableHead>
                                                <TableHead className="text-[10px] font-mono text-gray-500">
                                                    Grade
                                                </TableHead>
                                                <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                    Score
                                                </TableHead>
                                                <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                    Net Yield
                                                </TableHead>
                                                <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                    Gross Yield
                                                </TableHead>
                                                <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                    Median CZK/m2
                                                </TableHead>
                                                <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                    Comps
                                                </TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {history.map((entry) => (
                                                <TableRow
                                                    key={entry.id}
                                                    className="border-white/5 hover:bg-white/[0.02]"
                                                >
                                                    <TableCell className="text-xs font-mono text-gray-400">
                                                        {formatDateTime(entry.analyzed_at)}
                                                    </TableCell>
                                                    <TableCell>
                                                        {entry.grade ? (
                                                            <Badge
                                                                variant="outline"
                                                                className={cn(
                                                                    "text-[10px] font-mono",
                                                                    GRADE_COLORS[entry.grade] ??
                                                                        "border-white/10 text-gray-400"
                                                                )}
                                                            >
                                                                {entry.grade}
                                                            </Badge>
                                                        ) : (
                                                            <span className="text-xs font-mono text-gray-500">-</span>
                                                        )}
                                                    </TableCell>
                                                    <TableCell className="text-xs font-mono text-right text-amber-400">
                                                        {formatNumber(entry.score)}
                                                    </TableCell>
                                                    <TableCell className="text-xs font-mono text-right text-cyan-400">
                                                        {formatYield(entry.net_yield)}
                                                    </TableCell>
                                                    <TableCell className="text-xs font-mono text-right text-gray-300">
                                                        {formatYield(entry.gross_yield)}
                                                    </TableCell>
                                                    <TableCell className="text-xs font-mono text-right text-gray-300">
                                                        {formatCurrencyCompact(entry.median_price_per_m2)}
                                                    </TableCell>
                                                    <TableCell className="text-xs font-mono text-right text-gray-400">
                                                        {formatNumber(entry.comparable_count)}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
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

                <TabsContent value="export" className="space-y-4">
                    {exportData ? (
                        <>
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                <DetailMetric
                                    label="Target Price"
                                    value={formatCurrencyFull(exportData.meta.target.price)}
                                />
                                <DetailMetric
                                    label="Target Area"
                                    value={`${formatNumber(exportData.meta.target.area)} m2`}
                                />
                                <DetailMetric
                                    label="Providers"
                                    value={formatNumber(exportData.meta.providers.length)}
                                />
                                <DetailMetric label="Generated" value={formatDateTime(exportData.meta.generatedAt)} />
                            </div>

                            <Card className="border-white/5 bg-white/[0.02]">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm font-mono text-amber-400">
                                        Provider Fetch Summary
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="px-0">
                                    {exportData.meta.providerSummary && exportData.meta.providerSummary.length > 0 ? (
                                        <div className="overflow-x-auto">
                                            <Table>
                                                <TableHeader>
                                                    <TableRow className="border-white/5 hover:bg-transparent">
                                                        <TableHead className="text-[10px] font-mono text-gray-500">
                                                            Provider
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500">
                                                            Contract
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                            Count
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500">
                                                            Fetched
                                                        </TableHead>
                                                    </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                    {exportData.meta.providerSummary.map((provider) => (
                                                        <TableRow
                                                            key={`${provider.provider}-${provider.sourceContract}`}
                                                            className="border-white/5 hover:bg-white/[0.02]"
                                                        >
                                                            <TableCell className="text-xs font-mono text-gray-300">
                                                                {provider.provider}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-gray-500">
                                                                {provider.sourceContract}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-right text-cyan-400">
                                                                {formatNumber(provider.count)}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-gray-500">
                                                                {formatDateTime(provider.fetchedAt)}
                                                            </TableCell>
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                        </div>
                                    ) : (
                                        <p className="px-6 pb-6 text-xs font-mono text-gray-500">
                                            No provider summary stored.
                                        </p>
                                    )}
                                </CardContent>
                            </Card>

                            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                <Card className="border-white/5 bg-white/[0.02]">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm font-mono text-amber-400">
                                            Stored Sold Comparables
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="px-0">
                                        <div className="overflow-x-auto">
                                            <Table>
                                                <TableHeader>
                                                    <TableRow className="border-white/5 hover:bg-transparent">
                                                        <TableHead className="text-[10px] font-mono text-gray-500">
                                                            Address
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                            Price
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                            CZK/m2
                                                        </TableHead>
                                                    </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                    {exportData.listings.sold.slice(0, 8).map((listing, index) => (
                                                        <TableRow
                                                            key={`${listing.address}-${index}`}
                                                            className="border-white/5 hover:bg-white/[0.02]"
                                                        >
                                                            <TableCell className="text-xs font-mono text-gray-300 max-w-[260px] truncate">
                                                                {listing.address}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-right text-gray-300">
                                                                {formatCurrencyCompact(listing.price)}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-right text-cyan-400">
                                                                {formatCurrencyCompact(listing.pricePerM2)}
                                                            </TableCell>
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                        </div>
                                    </CardContent>
                                </Card>

                                <Card className="border-white/5 bg-white/[0.02]">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm font-mono text-amber-400">
                                            Stored Rental Listings
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="px-0">
                                        <div className="overflow-x-auto">
                                            <Table>
                                                <TableHeader>
                                                    <TableRow className="border-white/5 hover:bg-transparent">
                                                        <TableHead className="text-[10px] font-mono text-gray-500">
                                                            Address
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                            Rent
                                                        </TableHead>
                                                        <TableHead className="text-[10px] font-mono text-gray-500 text-right">
                                                            CZK/m2
                                                        </TableHead>
                                                    </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                    {exportData.listings.rentals.slice(0, 8).map((listing, index) => (
                                                        <TableRow
                                                            key={`${listing.address}-${index}`}
                                                            className="border-white/5 hover:bg-white/[0.02]"
                                                        >
                                                            <TableCell className="text-xs font-mono text-gray-300 max-w-[260px] truncate">
                                                                {listing.address}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-right text-gray-300">
                                                                {formatCurrencyCompact(listing.rent)}
                                                            </TableCell>
                                                            <TableCell className="text-xs font-mono text-right text-cyan-400">
                                                                {formatCurrencyCompact(listing.rentPerM2)}
                                                            </TableCell>
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                        </div>
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
            </Tabs>
        </div>
    );
}
