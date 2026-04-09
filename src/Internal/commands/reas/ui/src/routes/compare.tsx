import { DISPOSITIONS, PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Separator } from "@ui/components/separator";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib/utils";
import { Database, GitCompare, History, Loader2, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComparisonGrid } from "../components/compare/ComparisonGrid";
import { ComparisonMarketTable } from "../components/compare/ComparisonMarketTable";
import { ComparisonOverview } from "../components/compare/ComparisonOverview";
import { ComparisonRankingsTable } from "../components/compare/ComparisonRankingsTable";
import { ComparisonTrendSection } from "../components/compare/ComparisonTrendSection";
import {
    buildComparePeriodControlOptions,
    buildCompareSearchParams,
    parseCompareSearchParams,
} from "../components/compare/compare-query";
import { DistrictContextCallout } from "../components/compare/DistrictContextCallout";
import { DistrictDetailTable } from "../components/compare/DistrictDetailTable";
import { DistrictPicker } from "../components/compare/DistrictPicker";
import { DistrictPriceBarChart } from "../components/compare/DistrictPriceBarChart";
import { DistrictRadarComparison } from "../components/compare/DistrictRadarChart";
import { DistrictYieldBarChart } from "../components/compare/DistrictYieldBarChart";
import type { DistrictComparison } from "../components/compare/types";

export const Route = createFileRoute("/compare")({
    component: ComparePage,
});

interface DistrictComparisonResult {
    district: string;
    comparison: DistrictComparison | null;
    isLoading: boolean;
    error: string | null;
}

interface DistrictComparisonResponse {
    comparisons: DistrictComparison[];
}

interface DistrictPreseedResponse {
    total: number;
    succeeded: number;
    failed: number;
    warnings: string[];
}

function ComparePage() {
    const MAX_DISTRICTS = 12;
    const MIN_DISTRICTS = 2;
    const router = useRouter();
    const search = useRouterState({ select: (state) => state.location.searchStr });
    const initialSearchState = parseCompareSearchParams({ search, maxDistricts: MAX_DISTRICTS });

    const [selectedDistricts, setSelectedDistricts] = useState<string[]>(initialSearchState.districts);
    const [propertyType, setPropertyType] = useState(initialSearchState.propertyType);
    const [disposition, setDisposition] = useState(initialSearchState.disposition);
    const [periods, setPeriods] = useState(initialSearchState.periods);
    const [price, setPrice] = useState(initialSearchState.price);
    const [area, setArea] = useState(initialSearchState.area);
    const [snapshotResolution, setSnapshotResolution] = useState(initialSearchState.snapshotResolution);
    const [isComparing, setIsComparing] = useState(false);
    const [isPreseeding, setIsPreseeding] = useState(false);
    const [results, setResults] = useState<DistrictComparisonResult[]>([]);
    const [appliedSearch, setAppliedSearch] = useState<string | null>(search);
    const [preseedResult, setPreseedResult] = useState<DistrictPreseedResponse | null>(null);
    const [preseedError, setPreseedError] = useState<string | null>(null);
    const lastSyncedSearchRef = useRef<string | null>(null);
    const periodControlOptions = buildComparePeriodControlOptions(periods);

    useEffect(() => {
        const parsed = parseCompareSearchParams({ search, maxDistricts: MAX_DISTRICTS });

        setSelectedDistricts((current) => (arraysEqual(current, parsed.districts) ? current : parsed.districts));
        setPropertyType((current) => (current === parsed.propertyType ? current : parsed.propertyType));
        setDisposition((current) => (current === parsed.disposition ? current : parsed.disposition));
        setPeriods((current) => (current === parsed.periods ? current : parsed.periods));
        setPrice((current) => (current === parsed.price ? current : parsed.price));
        setArea((current) => (current === parsed.area ? current : parsed.area));
        setSnapshotResolution((current) =>
            current === parsed.snapshotResolution ? current : parsed.snapshotResolution
        );
        setAppliedSearch(search);
    }, [MAX_DISTRICTS, search]);

    useEffect(() => {
        if (appliedSearch !== search) {
            return;
        }

        const nextSearch = buildCompareSearchParams({
            districts: selectedDistricts,
            propertyType,
            disposition,
            periods,
            price,
            area,
            snapshotResolution,
        }).toString();
        const currentSearch = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).toString();

        if (lastSyncedSearchRef.current === nextSearch || currentSearch === nextSearch) {
            lastSyncedSearchRef.current = nextSearch;
            return;
        }

        lastSyncedSearchRef.current = nextSearch;
        router.navigate({
            to: nextSearch ? `/compare?${nextSearch}` : "/compare",
            replace: true,
        });
    }, [area, disposition, periods, price, propertyType, router, search, selectedDistricts, snapshotResolution]);

    const removeDistrict = useCallback((district: string) => {
        setSelectedDistricts((prev) => prev.filter((value) => value !== district));
    }, []);

    const runComparison = useCallback(async () => {
        if (selectedDistricts.length < MIN_DISTRICTS) {
            return;
        }

        setIsComparing(true);
        setResults(
            selectedDistricts.map((district) => ({
                district,
                comparison: null,
                isLoading: true,
                error: null,
            }))
        );

        try {
            const response = await fetch("/api/district-comparison", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify({
                    districts: selectedDistricts,
                    type: propertyType,
                    disposition: disposition === "all" ? undefined : disposition,
                    periods,
                    price,
                    area,
                    snapshotResolution,
                }),
            });

            if (!response.ok) {
                const body = (await response.json()) as { error?: string };
                throw new Error(body.error ?? `HTTP ${response.status}`);
            }

            const body = (await response.json()) as DistrictComparisonResponse;
            const byDistrict = new Map(body.comparisons.map((comparison) => [comparison.district, comparison]));

            setResults(
                selectedDistricts.map((district) => {
                    const comparison = byDistrict.get(district) ?? null;

                    if (!comparison) {
                        return {
                            district,
                            comparison: null,
                            isLoading: false,
                            error: "Comparison result missing from response",
                        };
                    }

                    return {
                        district,
                        comparison,
                        isLoading: false,
                        error: null,
                    };
                })
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";

            setResults(
                selectedDistricts.map((district) => ({
                    district,
                    comparison: null,
                    isLoading: false,
                    error: message,
                }))
            );
        } finally {
            setIsComparing(false);
        }
    }, [selectedDistricts, propertyType, disposition, periods, price, area, snapshotResolution]);

    const runPrahaPreseed = useCallback(async () => {
        setIsPreseeding(true);
        setPreseedError(null);

        try {
            const response = await fetch("/api/district-snapshots", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify({
                    action: "preseed-praha",
                    type: propertyType,
                    disposition: disposition === "all" ? undefined : disposition,
                    periods,
                    price,
                    area,
                }),
            });
            const body = (await response.json()) as DistrictPreseedResponse | { error?: string };

            if (!response.ok) {
                const message =
                    "error" in body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;

                throw new Error(message);
            }

            setPreseedResult(body as DistrictPreseedResponse);

            if (selectedDistricts.length >= MIN_DISTRICTS) {
                await runComparison();
            }
        } catch (error) {
            setPreseedError(error instanceof Error ? error.message : "Unknown error");
        } finally {
            setIsPreseeding(false);
        }
    }, [area, disposition, periods, price, propertyType, runComparison, selectedDistricts.length]);

    const canCompare = selectedDistricts.length >= MIN_DISTRICTS && !isComparing;
    const loadedComparisons = results.flatMap((result) => (result.comparison ? [result.comparison] : []));
    const errors = results.filter((result) => result.error);
    const targetDistrict = selectedDistricts[0];
    const targetPricePerM2 = Number(price) > 0 && Number(area) > 0 ? Number(price) / Number(area) : undefined;
    const selectedPrahaWards = selectedDistricts.filter((district) => district.startsWith("Praha ")).length;
    const selectedRegionalDistricts = selectedDistricts.length - selectedPrahaWards;
    const resolutionLabel = snapshotResolution === "monthly" ? "Monthly snapshots" : "Daily snapshots";

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            <section className="relative mb-6 overflow-hidden rounded-3xl border border-white/8 bg-[#09101b] px-5 py-6 sm:px-7 sm:py-7">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.18),_transparent_42%),radial-gradient(circle_at_bottom_right,_rgba(245,158,11,0.18),_transparent_36%)]" />
                <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center gap-3">
                            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-2.5 shadow-[0_0_32px_rgba(245,158,11,0.15)]">
                                <GitCompare className="h-5 w-5 text-amber-300" />
                            </div>
                            <div>
                                <div className="text-[11px] font-mono uppercase tracking-[0.32em] text-cyan-300/80">
                                    District intelligence
                                </div>
                                <h1 className="text-2xl font-mono font-bold text-white sm:text-3xl">
                                    Compare Prague wards and market leaders in one command deck
                                </h1>
                            </div>
                        </div>

                        <p className="max-w-3xl text-sm font-mono leading-6 text-slate-300/80">
                            Stack districts into a shared basket, flip the trend cadence between monthly and daily
                            snapshots, and warm the Praha cache before visual review so the comparison story lands fast.
                        </p>

                        <div className="flex flex-wrap gap-2">
                            <Badge
                                variant="outline"
                                className="border-cyan-500/30 bg-cyan-500/10 font-mono text-[10px] text-cyan-200"
                            >
                                Shareable URL state
                            </Badge>
                            <Badge
                                variant="outline"
                                className="border-amber-500/30 bg-amber-500/10 font-mono text-[10px] text-amber-200"
                            >
                                {resolutionLabel}
                            </Badge>
                            <Badge
                                variant="outline"
                                className="border-white/10 bg-white/[0.04] font-mono text-[10px] text-slate-300"
                            >
                                Praha wards {selectedPrahaWards}
                            </Badge>
                            <Badge
                                variant="outline"
                                className="border-white/10 bg-white/[0.04] font-mono text-[10px] text-slate-300"
                            >
                                Regional districts {selectedRegionalDistricts}
                            </Badge>
                        </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                        <HeroMetricCard
                            icon={<Sparkles className="h-4 w-4 text-cyan-300" />}
                            label="Basket"
                            value={`${selectedDistricts.length}/${MAX_DISTRICTS}`}
                            detail="Balanced side-by-side reads"
                        />
                        <HeroMetricCard
                            icon={<History className="h-4 w-4 text-amber-300" />}
                            label="Trend mode"
                            value={snapshotResolution === "monthly" ? "Monthly" : "Daily"}
                            detail="Overlay chart cadence"
                        />
                        <HeroMetricCard
                            icon={<Database className="h-4 w-4 text-emerald-300" />}
                            label="Target lens"
                            value={
                                targetPricePerM2 ? `${Math.round(targetPricePerM2).toLocaleString("cs-CZ")}` : "Ready"
                            }
                            detail={
                                targetPricePerM2 ? "CZK/m² target marker armed" : "Add price + area for a target line"
                            }
                        />
                    </div>
                </div>
            </section>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                <div className="lg:col-span-1 self-start" style={{ zIndex: 20 }}>
                    <DistrictPicker
                        selectedDistricts={selectedDistricts}
                        setSelectedDistricts={setSelectedDistricts}
                        maxDistricts={MAX_DISTRICTS}
                    />
                </div>

                <div className="lg:col-span-2 space-y-4">
                    {selectedDistricts.length > 0 && (
                        <div className="flex flex-wrap gap-2 rounded-2xl border border-white/5 bg-white/[0.02] p-3">
                            {selectedDistricts.map((district) => (
                                <Badge
                                    key={district}
                                    variant="outline"
                                    className="border-amber-500/30 bg-amber-500/5 px-2 py-1 text-xs font-mono text-amber-300"
                                >
                                    <span className="mr-1">{district}</span>
                                    <button
                                        type="button"
                                        onClick={() => removeDistrict(district)}
                                        aria-label={`Remove ${district} from comparison`}
                                        className="hover:text-red-400"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </Badge>
                            ))}
                        </div>
                    )}

                    <Card className="border-white/5 bg-white/[0.02]">
                        <CardHeader className="gap-3 pb-2">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <CardTitle className="text-xs font-mono text-gray-300">Shared configuration</CardTitle>
                                <Badge
                                    variant="outline"
                                    className="border-white/10 bg-white/[0.03] font-mono text-[10px] text-slate-300"
                                >
                                    URL synced
                                </Badge>
                            </div>
                            <p className="text-xs font-mono text-gray-500">
                                Keep one pricing lens across every district so the charts, ranks, and context cards stay
                                aligned.
                            </p>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                                <label className="block">
                                    <span className="block text-[10px] font-mono text-gray-500 mb-1">
                                        Property Type
                                    </span>
                                    <select
                                        value={propertyType}
                                        onChange={(event) => setPropertyType(event.target.value)}
                                        className="cyber-select"
                                    >
                                        {PROPERTY_TYPES.map((type) => (
                                            <option key={type.value} value={type.value}>
                                                {type.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="block text-[10px] font-mono text-gray-500 mb-1">Disposition</span>
                                    <select
                                        value={disposition}
                                        onChange={(event) => setDisposition(event.target.value)}
                                        className="cyber-select"
                                    >
                                        {DISPOSITIONS.map((value) => (
                                            <option key={value.value} value={value.value}>
                                                {value.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="block text-[10px] font-mono text-gray-500 mb-1">Sold Horizon</span>
                                    <select
                                        value={periods}
                                        onChange={(event) => setPeriods(event.target.value)}
                                        className="cyber-select"
                                    >
                                        {periodControlOptions.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <div>
                                    <label
                                        htmlFor="compare-price"
                                        className="block text-[10px] font-mono text-gray-500 mb-1"
                                    >
                                        Price (CZK)
                                    </label>
                                    <Input
                                        id="compare-price"
                                        type="number"
                                        value={price}
                                        onChange={(event) => setPrice(event.target.value)}
                                        className="h-8 text-xs font-mono bg-black/20 border-white/10"
                                    />
                                </div>
                                <div>
                                    <label
                                        htmlFor="compare-area"
                                        className="block text-[10px] font-mono text-gray-500 mb-1"
                                    >
                                        Area (m2)
                                    </label>
                                    <Input
                                        id="compare-area"
                                        type="number"
                                        value={area}
                                        onChange={(event) => setArea(event.target.value)}
                                        className="h-8 text-xs font-mono bg-black/20 border-white/10"
                                    />
                                </div>
                            </div>

                            <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                    <div>
                                        <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-cyan-300/80">
                                            Trend cadence
                                        </div>
                                        <p className="mt-1 text-xs font-mono text-gray-400">
                                            Monthly mode smooths the district story for presentations. Daily mode
                                            exposes every cached swing.
                                        </p>
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        {(
                                            [
                                                { value: "monthly", label: "Monthly snapshots" },
                                                { value: "daily", label: "Daily snapshots" },
                                            ] as const
                                        ).map((option) => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                onClick={() => setSnapshotResolution(option.value)}
                                                aria-pressed={snapshotResolution === option.value}
                                                className={cn(
                                                    "rounded-full border px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.24em] transition-colors",
                                                    snapshotResolution === option.value
                                                        ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
                                                        : "border-white/10 bg-black/20 text-gray-500 hover:border-white/20 hover:text-gray-300"
                                                )}
                                            >
                                                {option.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {(preseedResult || preseedError) && (
                        <Alert variant={preseedError ? "destructive" : "warning"}>
                            <AlertTitle className="font-mono text-xs">
                                {preseedError ? "Praha cache warm-up failed" : "Praha cache warm-up complete"}
                            </AlertTitle>
                            <AlertDescription className="font-mono text-xs text-current/80">
                                {preseedError
                                    ? preseedError
                                    : `Seeded ${preseedResult?.succeeded ?? 0}/${preseedResult?.total ?? 0} Praha wards.${preseedResult?.failed ? ` ${preseedResult.failed} district(s) still need a retry.` : ""}`}
                                {!preseedError && (preseedResult?.warnings.length ?? 0) > 0
                                    ? ` Latest warning: ${preseedResult?.warnings[0]}`
                                    : null}
                            </AlertDescription>
                        </Alert>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
                        <Button
                            onClick={runComparison}
                            disabled={!canCompare}
                            className="w-full border border-amber-500/30 bg-amber-500/10 font-mono text-sm text-amber-300 hover:bg-amber-500/20"
                        >
                            {isComparing ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Comparing {selectedDistricts.length} districts...
                                </>
                            ) : (
                                <>
                                    <GitCompare className="mr-2 h-4 w-4" />
                                    Compare {selectedDistricts.length} districts
                                </>
                            )}
                        </Button>

                        <Button
                            type="button"
                            variant="outline"
                            onClick={runPrahaPreseed}
                            disabled={isPreseeding || isComparing}
                            className="w-full border-cyan-500/30 bg-cyan-500/10 font-mono text-sm text-cyan-200 hover:bg-cyan-500/15"
                        >
                            {isPreseeding ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Warming Praha cache...
                                </>
                            ) : (
                                <>
                                    <Database className="mr-2 h-4 w-4" />
                                    Warm Praha 1-22 cache
                                </>
                            )}
                        </Button>
                    </div>
                </div>
            </div>

            {results.length > 0 && (
                <div className="space-y-6">
                    {isComparing && <ComparisonLoadingState districts={selectedDistricts} />}

                    {!isComparing && errors.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {errors.map((result) => (
                                <Card key={result.district} className="border-red-500/20 bg-red-500/5">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm font-mono text-red-300">
                                            {result.district}
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="text-xs font-mono text-red-200/80">{result.error}</p>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}

                    {!isComparing && loadedComparisons.length > 0 && (
                        <>
                            <ComparisonOverview comparisons={loadedComparisons} />
                            <section className="grid gap-6 xl:grid-cols-2">
                                <div className="min-w-0">
                                    <DistrictPriceBarChart
                                        comparisons={loadedComparisons}
                                        targetDistrict={targetDistrict}
                                        targetPricePerM2={targetPricePerM2}
                                    />
                                </div>
                                <div className="min-w-0">
                                    <DistrictYieldBarChart
                                        comparisons={loadedComparisons}
                                        targetDistrict={targetDistrict}
                                    />
                                </div>
                            </section>

                            <DistrictDetailTable comparisons={loadedComparisons} />

                            <ComparisonTrendSection
                                comparisons={loadedComparisons}
                                snapshotResolution={snapshotResolution}
                            />

                            <DistrictRadarComparison
                                comparisons={loadedComparisons}
                                selectedDistricts={selectedDistricts}
                            />

                            <DistrictContextCallout
                                districts={loadedComparisons.map((comparison) => comparison.district)}
                            />

                            <Separator className="bg-white/5" />

                            <div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
                                <div className="min-w-0">
                                    <ComparisonGrid comparisons={loadedComparisons} />
                                </div>
                                <div className="min-w-0">
                                    <ComparisonRankingsTable comparisons={loadedComparisons} />
                                </div>
                                <div className="min-w-0">
                                    <ComparisonMarketTable comparisons={loadedComparisons} />
                                </div>
                            </div>

                            <Card className="border-white/5 bg-white/[0.02]">
                                <CardHeader>
                                    <CardTitle className="text-sm font-mono text-amber-300">Data provenance</CardTitle>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-3 text-xs font-mono text-gray-400">
                                    {loadedComparisons.map((comparison) => (
                                        <div
                                            key={comparison.district}
                                            className="rounded-lg border border-white/5 bg-black/20 p-3"
                                        >
                                            <div className="text-gray-200">{comparison.district}</div>
                                            <div className="mt-1">
                                                Providers: {(comparison.exportData.meta.providers ?? []).join(" · ")}
                                            </div>
                                            <div className="mt-1">
                                                Sold {comparison.summary.salesCount} · Rentals{" "}
                                                {comparison.summary.rentalCount} · Active{" "}
                                                {comparison.exportData.listings.activeSales.length}
                                            </div>
                                        </div>
                                    ))}
                                </CardContent>
                            </Card>
                        </>
                    )}
                </div>
            )}

            {results.length === 0 && !isComparing && (
                <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center">
                    <p className="text-sm font-mono text-gray-500">
                        {selectedDistricts.length < MIN_DISTRICTS
                            ? `Select at least ${MIN_DISTRICTS} districts to compare`
                            : "Click 'Compare' to run analysis"}
                    </p>
                </div>
            )}
        </div>
    );
}

function arraysEqual(left: string[], right: string[]) {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function HeroMetricCard({
    icon,
    label,
    value,
    detail,
}: {
    icon: ReactNode;
    label: string;
    value: string;
    detail: string;
}) {
    return (
        <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-4 backdrop-blur-sm">
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.28em] text-slate-400">
                {icon}
                {label}
            </div>
            <div className="mt-3 text-lg font-mono font-semibold text-white">{value}</div>
            <div className="mt-1 text-xs font-mono text-slate-400">{detail}</div>
        </div>
    );
}

function ComparisonLoadingState({ districts }: { districts: string[] }) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {districts.map((district) => (
                <Card key={district} className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-mono text-gray-300">{district}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Skeleton variant="line" className="h-4 w-2/3" />
                        <Skeleton variant="line" className="h-4 w-1/2" />
                        <Skeleton variant="line" className="h-4 w-3/4" />
                        <Skeleton variant="default" className="h-20 w-full rounded-lg" />
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
