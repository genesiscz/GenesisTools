import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { ScrollArea } from "@ui/components/scroll-area";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib/utils";
import { Check, GitCompare, Loader2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { ComparisonGrid } from "../components/compare/ComparisonGrid";

export const Route = createFileRoute("/compare")({
    component: ComparePage,
});

const PROPERTY_TYPES = [
    { value: "panel", label: "Panel" },
    { value: "brick", label: "Brick" },
    { value: "house", label: "House" },
];

const DISPOSITIONS = [
    { value: "all", label: "All" },
    { value: "1+1", label: "1+1" },
    { value: "1+kk", label: "1+kk" },
    { value: "2+1", label: "2+1" },
    { value: "2+kk", label: "2+kk" },
    { value: "3+1", label: "3+1" },
    { value: "3+kk", label: "3+kk" },
    { value: "4+1", label: "4+1" },
    { value: "4+kk", label: "4+kk" },
];

interface DistrictsResponse {
    districts: string[];
    praha: string[];
}

interface DistrictAnalysisResult {
    district: string;
    data: DashboardExport | null;
    isLoading: boolean;
    error: string | null;
}

function useDistrictsList() {
    return useQuery<DistrictsResponse>({
        queryKey: ["districts"],
        queryFn: async () => {
            const res = await fetch("/api/districts");

            if (!res.ok) {
                throw new Error("Failed to fetch districts");
            }

            return res.json();
        },
        staleTime: 60_000 * 10,
    });
}

function DistrictSelector({
    districts,
    selected,
    onToggle,
    maxSelection,
}: {
    districts: string[];
    selected: string[];
    onToggle: (district: string) => void;
    maxSelection: number;
}) {
    const [filter, setFilter] = useState("");
    const filtered = filter ? districts.filter((d) => d.toLowerCase().includes(filter.toLowerCase())) : districts;

    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-mono text-gray-400">
                    Select Districts ({selected.length}/{maxSelection})
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
                <Input
                    placeholder="Filter districts..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="h-8 text-xs font-mono bg-black/20 border-white/10"
                />
                <ScrollArea className="h-48">
                    <div className="space-y-1">
                        {filtered.map((d) => {
                            const isSelected = selected.includes(d);
                            const isDisabled = !isSelected && selected.length >= maxSelection;

                            return (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => {
                                        if (!isDisabled) {
                                            onToggle(d);
                                        }
                                    }}
                                    className={cn(
                                        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono transition-all text-left",
                                        isSelected
                                            ? "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                                            : isDisabled
                                              ? "text-gray-600 cursor-not-allowed"
                                              : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                                    )}
                                >
                                    {isSelected ? (
                                        <Check className="w-3 h-3 text-amber-400 shrink-0" />
                                    ) : (
                                        <div className="w-3 h-3 rounded-sm border border-white/10 shrink-0" />
                                    )}
                                    {d}
                                </button>
                            );
                        })}
                    </div>
                </ScrollArea>
            </CardContent>
        </Card>
    );
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
    const [results, setResults] = useState<DistrictAnalysisResult[]>([]);

    const { data: districtsData, isLoading: districtsLoading } = useDistrictsList();

    const allDistricts = districtsData
        ? [...districtsData.praha, ...districtsData.districts.filter((d) => !districtsData.praha.includes(d))]
        : [];

    const toggleDistrict = useCallback((district: string) => {
        setSelectedDistricts((prev) => {
            if (prev.includes(district)) {
                return prev.filter((d) => d !== district);
            }

            if (prev.length >= MAX_DISTRICTS) {
                return prev;
            }

            return [...prev, district];
        });
    }, []);

    const removeDistrict = useCallback((district: string) => {
        setSelectedDistricts((prev) => prev.filter((d) => d !== district));
    }, []);

    const runComparison = useCallback(async () => {
        if (selectedDistricts.length < MIN_DISTRICTS) {
            return;
        }

        setIsComparing(true);
        setResults(
            selectedDistricts.map((d) => ({
                district: d,
                data: null,
                isLoading: true,
                error: null,
            }))
        );

        const settled = await Promise.allSettled(
            selectedDistricts.map(async (district) => {
                const res = await fetch("/api/analysis", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: globalThis.JSON.stringify({
                        district,
                        type: propertyType,
                        disposition: disposition === "all" ? undefined : disposition,
                        price,
                        area,
                    }),
                });

                if (!res.ok) {
                    const body = (await res.json()) as { error?: string };
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                }

                return (await res.json()) as DashboardExport;
            })
        );

        const finalResults: DistrictAnalysisResult[] = settled.map((result, i) => {
            if (result.status === "fulfilled") {
                return {
                    district: selectedDistricts[i],
                    data: result.value,
                    isLoading: false,
                    error: null,
                };
            }

            return {
                district: selectedDistricts[i],
                data: null,
                isLoading: false,
                error: result.reason instanceof Error ? result.reason.message : "Unknown error",
            };
        });

        setResults(finalResults);
        setIsComparing(false);
    }, [selectedDistricts, propertyType, disposition, price, area]);

    const canCompare = selectedDistricts.length >= MIN_DISTRICTS && !isComparing;

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                    <GitCompare className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                    <h1 className="text-xl font-mono font-bold text-gray-200">Compare</h1>
                    <p className="text-xs text-gray-500 font-mono">Side-by-side district comparison with trends</p>
                </div>
            </div>

            {/* Configuration */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                {/* District selector */}
                <div className="lg:col-span-1">
                    {districtsLoading ? (
                        <Card className="border-white/5 bg-white/[0.02]">
                            <CardContent className="p-4 space-y-2">
                                <Skeleton variant="text" className="h-4 w-2/3" />
                                <Skeleton variant="text" className="h-8 w-full" />
                                <Skeleton variant="text" className="h-32 w-full" />
                            </CardContent>
                        </Card>
                    ) : (
                        <DistrictSelector
                            districts={allDistricts}
                            selected={selectedDistricts}
                            onToggle={toggleDistrict}
                            maxSelection={MAX_DISTRICTS}
                        />
                    )}
                </div>

                {/* Config + selected */}
                <div className="lg:col-span-2 space-y-4">
                    {/* Selected districts */}
                    {selectedDistricts.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {selectedDistricts.map((d) => (
                                <Badge
                                    key={d}
                                    variant="outline"
                                    className="border-amber-500/30 text-amber-400 bg-amber-500/5 text-xs font-mono px-2 py-1 flex items-center gap-1"
                                >
                                    {d}
                                    <button
                                        type="button"
                                        onClick={() => removeDistrict(d)}
                                        className="hover:text-red-400"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </Badge>
                            ))}
                        </div>
                    )}

                    {/* Shared config */}
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
                                        onChange={(e) => setPropertyType(e.target.value)}
                                        className="w-full h-8 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                                    >
                                        {PROPERTY_TYPES.map((t) => (
                                            <option key={t.value} value={t.value}>
                                                {t.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block">
                                    <span className="block text-[10px] font-mono text-gray-500 mb-1">Disposition</span>
                                    <select
                                        value={disposition}
                                        onChange={(e) => setDisposition(e.target.value)}
                                        className="w-full h-8 rounded bg-black/20 border border-white/10 text-xs font-mono text-gray-300 px-2"
                                    >
                                        {DISPOSITIONS.map((d) => (
                                            <option key={d.value} value={d.value}>
                                                {d.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <div>
                                    <label htmlFor="compare-price" className="block text-[10px] font-mono text-gray-500 mb-1">
                                        Price (CZK)
                                    </label>
                                    <Input
                                        id="compare-price"
                                        type="number"
                                        value={price}
                                        onChange={(e) => setPrice(e.target.value)}
                                        className="h-8 text-xs font-mono bg-black/20 border-white/10"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="compare-area" className="block text-[10px] font-mono text-gray-500 mb-1">
                                        Area (m2)
                                    </label>
                                    <Input
                                        id="compare-area"
                                        type="number"
                                        value={area}
                                        onChange={(e) => setArea(e.target.value)}
                                        className="h-8 text-xs font-mono bg-black/20 border-white/10"
                                    />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Compare button */}
                    <Button
                        onClick={runComparison}
                        disabled={!canCompare}
                        className="w-full bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 font-mono text-sm"
                    >
                        {isComparing ? (
                            <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Analyzing {selectedDistricts.length} districts...
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

            {/* Results */}
            {results.length > 0 && <ComparisonGrid results={results} />}

            {/* Empty state */}
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
