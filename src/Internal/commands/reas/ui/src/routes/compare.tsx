import { DISPOSITIONS, PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { DistrictCommandSelect } from "@ui/components/command";
import { Input } from "@ui/components/input";
import { Skeleton } from "@ui/components/skeleton";
import { GitCompare, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComparisonGrid } from "../components/compare/ComparisonGrid";
import { ComparisonMarketTable } from "../components/compare/ComparisonMarketTable";
import { ComparisonOverview } from "../components/compare/ComparisonOverview";
import { ComparisonRankingsTable } from "../components/compare/ComparisonRankingsTable";
import { ComparisonTrendSection } from "../components/compare/ComparisonTrendSection";
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

function ComparePage() {
    const MAX_DISTRICTS = 4;
    const MIN_DISTRICTS = 2;

    const [selectedDistricts, setSelectedDistricts] = useState<string[]>([]);
    const [propertyType, setPropertyType] = useState("brick");
    const [disposition, setDisposition] = useState("all");
    const [price, setPrice] = useState("5000000");
    const [area, setArea] = useState("80");
    const [isComparing, setIsComparing] = useState(false);
    const [results, setResults] = useState<DistrictComparisonResult[]>([]);
    const search = useRouterState({ select: (state) => state.location.searchStr });
    const hydratedFromSearchRef = useRef(false);

    useEffect(() => {
        if (hydratedFromSearchRef.current) {
            return;
        }

        hydratedFromSearchRef.current = true;

        const params = new URLSearchParams(search);
        const districts = params
            .get("districts")
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const type = params.get("type");
        const nextDisposition = params.get("disposition");
        const nextPrice = params.get("price");
        const nextArea = params.get("area");

        if (districts && districts.length > 0) {
            setSelectedDistricts(districts.slice(0, MAX_DISTRICTS));
        }

        if (type) {
            setPropertyType(type);
        }

        if (nextDisposition) {
            setDisposition(nextDisposition);
        }

        if (nextPrice) {
            setPrice(nextPrice);
        }

        if (nextArea) {
            setArea(nextArea);
        }
    }, [MAX_DISTRICTS, search]);

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
                    price,
                    area,
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
    }, [selectedDistricts, propertyType, disposition, price, area]);

    const canCompare = selectedDistricts.length >= MIN_DISTRICTS && !isComparing;
    const loadedComparisons = results.flatMap((result) => (result.comparison ? [result.comparison] : []));
    const errors = results.filter((result) => result.error);

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                    <GitCompare className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                    <h1 className="text-xl font-mono font-bold text-gray-200">Compare</h1>
                    <p className="text-xs text-gray-500 font-mono">
                        District comparison with shared filters, rankings, charts, and export-ready summaries
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                <div className="lg:col-span-1 self-start" style={{ zIndex: 20 }}>
                    <Card className="border-white/5 bg-white/[0.02] overflow-visible">
                        <CardHeader>
                            <CardTitle className="text-xs font-mono text-gray-400">
                                Select Districts ({selectedDistricts.length}/{MAX_DISTRICTS})
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="overflow-visible">
                            <DistrictCommandSelect
                                mode="multi"
                                selected={selectedDistricts}
                                onValueChange={setSelectedDistricts}
                                maxSelections={MAX_DISTRICTS}
                                placeholder="Select districts..."
                                searchPlaceholder="Search districts..."
                                shouldFilter={false}
                            />
                        </CardContent>
                    </Card>
                </div>

                <div className="lg:col-span-2 space-y-4">
                    {selectedDistricts.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {selectedDistricts.map((district) => (
                                <Badge
                                    key={district}
                                    variant="outline"
                                    className="border-amber-500/30 text-amber-400 bg-amber-500/5 text-xs font-mono px-2 py-1 flex items-center gap-1"
                                >
                                    {district}
                                    <button
                                        type="button"
                                        onClick={() => removeDistrict(district)}
                                        className="hover:text-red-400"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </Badge>
                            ))}
                        </div>
                    )}

                    <Card className="border-white/5 bg-white/[0.02]">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-mono text-gray-400">Shared Configuration</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
                        </CardContent>
                    </Card>

                    <Button
                        onClick={runComparison}
                        disabled={!canCompare}
                        className="w-full bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 font-mono text-sm"
                    >
                        {isComparing ? (
                            <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Comparing {selectedDistricts.length} districts...
                            </>
                        ) : (
                            <>
                                <GitCompare className="w-4 h-4 mr-2" />
                                Compare {selectedDistricts.length} Districts
                            </>
                        )}
                    </Button>
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
                            <ComparisonGrid comparisons={loadedComparisons} />
                            <ComparisonTrendSection comparisons={loadedComparisons} />
                            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
                                <ComparisonRankingsTable comparisons={loadedComparisons} />
                                <ComparisonMarketTable comparisons={loadedComparisons} />
                            </div>
                        </>
                    )}
                </div>
            )}

            {results.length === 0 && !isComparing && (
                <div className="border border-white/5 rounded-lg p-8 text-center">
                    <p className="text-sm text-gray-500 font-mono">
                        {selectedDistricts.length < MIN_DISTRICTS
                            ? `Select at least ${MIN_DISTRICTS} districts to compare`
                            : "Click 'Compare' to run analysis"}
                    </p>
                </div>
            )}
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
