import type {
    PropertyAnalysisHistoryRow,
    SavedPropertyRow,
    SavePropertyInput,
} from "@app/Internal/commands/reas/lib/store";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Skeleton } from "@ui/components/skeleton";
import { toast } from "@ui/index";
import { ArrowDownAZ, ArrowUpAZ, Loader2, RefreshCw, Search, Star } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { AddPropertyForm } from "../components/watchlist/AddPropertyForm";
import { buildWatchlistCompareQuery } from "../components/watchlist/compare-query";
import { PropertyCard } from "../components/watchlist/PropertyCard";
import { type RefreshAllProgress, refreshPropertiesSequentially } from "../components/watchlist/refresh-all";
import { screenWatchlistProperties, type WatchlistSortKey } from "../components/watchlist/watchlist-screening";
import {
    formatCurrencyCompact,
    formatNumber,
    formatYield,
    getStalenessInfo,
} from "../components/watchlist/watchlist-utils";

export const Route = createFileRoute("/watchlist")({
    component: WatchlistPage,
});

interface PropertiesResponse {
    properties: SavedPropertyRow[];
    historyByProperty: Record<number, PropertyAnalysisHistoryRow[]>;
}

interface SummaryMetricProps {
    label: string;
    value: string;
    hint: string;
    tone?: "default" | "accent" | "warning";
}

const WATCHLIST_SKELETON_KEYS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] as const;

function useProperties() {
    return useQuery<PropertiesResponse>({
        queryKey: ["properties"],
        queryFn: async () => {
            const res = await fetch("/api/properties");

            if (!res.ok) {
                throw new Error("Failed to fetch properties");
            }

            return res.json();
        },
    });
}

function SummaryMetric({ label, value, hint, tone = "default" }: SummaryMetricProps) {
    return (
        <Card className="border-white/5 bg-white/[0.02]">
            <CardHeader className="pb-2">
                <CardTitle className="text-[10px] font-mono uppercase tracking-[0.18em] text-gray-600">
                    {label}
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div
                    className={[
                        "text-2xl font-mono font-bold",
                        tone === "accent" ? "text-cyan-400" : "",
                        tone === "warning" ? "text-amber-400" : "",
                        tone === "default" ? "text-gray-100" : "",
                    ].join(" ")}
                >
                    {value}
                </div>
                <p className="mt-1 text-[10px] font-mono text-gray-500">{hint}</p>
            </CardContent>
        </Card>
    );
}

function WatchlistPage() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });

    if (pathname !== "/watchlist") {
        return <Outlet />;
    }

    return <WatchlistIndexPage />;
}

function WatchlistIndexPage() {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { data: propertiesData, isLoading: propertiesLoading } = useProperties();

    const [search, setSearch] = useState("");
    const [districtFilter, setDistrictFilter] = useState("all");
    const [gradeFilter, setGradeFilter] = useState("all");
    const [analysisFilter, setAnalysisFilter] = useState("all");
    const [yieldMin, setYieldMin] = useState("");
    const [yieldMax, setYieldMax] = useState("");
    const [sortKey, setSortKey] = useState<WatchlistSortKey>("updated");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
    const [refreshAllProgress, setRefreshAllProgress] = useState<RefreshAllProgress | null>(null);
    const [refreshAllActive, setRefreshAllActive] = useState(false);
    const [selectedCompareIds, setSelectedCompareIds] = useState<number[]>([]);

    const addMutation = useMutation({
        mutationFn: async (input: SavePropertyInput) => {
            const res = await fetch("/api/properties", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify(input),
            });

            if (!res.ok) {
                const body = (await res.json()) as { error?: string };
                throw new Error(body.error ?? "Failed to add property");
            }

            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Property added to watchlist");
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: number) => {
            const res = await fetch(`/api/properties?id=${id}`, {
                method: "DELETE",
            });

            if (!res.ok) {
                throw new Error("Failed to delete property");
            }

            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Property removed from watchlist");
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    const updateAlertsMutation = useMutation({
        mutationFn: async (options: { id: number; alertYieldFloor?: number; alertGradeChange: boolean }) => {
            const response = await fetch(`/api/properties?id=${options.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify({
                    action: "update-settings",
                    alertYieldFloor: options.alertYieldFloor ?? null,
                    alertGradeChange: options.alertGradeChange,
                }),
            });

            const body = (await response.json()) as { error?: string };

            if (!response.ok) {
                throw new Error(body.error ?? "Failed to update alerts");
            }
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Alert settings updated");
        },
        onError: (error: Error) => {
            toast.error(error.message);
        },
    });

    const handleRefresh = useCallback(
        async (id: number) => {
            const res = await fetch(`/api/properties?id=${id}`, {
                method: "PATCH",
            });

            if (!res.ok) {
                const body = (await res.json()) as { error?: string };
                toast.error(body.error ?? "Failed to refresh property");
                return;
            }

            await queryClient.invalidateQueries({ queryKey: ["properties"] });
            toast.success("Analysis refreshed");
        },
        [queryClient]
    );

    const refreshProperty = useCallback(async (id: number) => {
        const res = await fetch(`/api/properties?id=${id}`, {
            method: "PATCH",
        });

        if (!res.ok) {
            const body = (await res.json()) as { error?: string };
            throw new Error(body.error ?? `Failed to refresh property ${id}`);
        }
    }, []);

    const handleDelete = useCallback(
        (id: number) => {
            deleteMutation.mutate(id);
        },
        [deleteMutation]
    );

    const handleUpdateAlerts = useCallback(
        async (options: { id: number; alertYieldFloor?: number; alertGradeChange: boolean }) => {
            await updateAlertsMutation.mutateAsync(options);
        },
        [updateAlertsMutation]
    );

    const handleAdd = useCallback(
        async (input: SavePropertyInput) => {
            await addMutation.mutateAsync(input);
        },
        [addMutation]
    );

    const properties = propertiesData?.properties ?? [];
    const historyByProperty = propertiesData?.historyByProperty ?? {};
    const selectedCompareProperties = properties.filter((property) => selectedCompareIds.includes(property.id));
    const selectedCompareDistricts = [...new Set(selectedCompareProperties.map((property) => property.district))];

    const handleRefreshAll = useCallback(async () => {
        if (properties.length === 0 || refreshAllActive) {
            return;
        }

        setRefreshAllActive(true);
        setRefreshAllProgress({
            completed: 0,
            failed: 0,
            total: properties.length,
            propertyId: properties[0]?.id ?? 0,
        });

        try {
            const result = await refreshPropertiesSequentially({
                propertyIds: properties.map((property) => property.id),
                refreshProperty,
                onProgress: (progress) => {
                    setRefreshAllProgress(progress);
                },
            });

            await queryClient.invalidateQueries({ queryKey: ["properties"] });

            if (result.failed > 0) {
                toast.error(`Refreshed ${result.completed}/${result.total}; ${result.failed} failed`);
            } else {
                toast.success(`Refreshed ${result.completed} properties`);
            }
        } finally {
            setRefreshAllActive(false);
        }
    }, [properties, queryClient, refreshAllActive, refreshProperty]);

    const toggleCompareSelection = useCallback((id: number) => {
        setSelectedCompareIds((current) => {
            if (current.includes(id)) {
                return current.filter((value) => value !== id);
            }

            if (current.length >= 4) {
                return current;
            }

            return [...current, id];
        });
    }, []);

    const openCompare = useCallback(() => {
        if (selectedCompareDistricts.length < 2) {
            toast.error("Select properties from at least two districts to compare");
            return;
        }

        const params = buildWatchlistCompareQuery(selectedCompareProperties);
        router.navigate({ to: `/compare?${params.toString()}` });
    }, [router, selectedCompareDistricts.length, selectedCompareProperties]);

    const summary = useMemo(() => {
        const analyzed = properties.filter((property) => property.last_analyzed_at);
        const stale = properties.filter((property) => getStalenessInfo(property.last_analyzed_at).isStale);
        const avgNetYield =
            analyzed.reduce((total, property) => total + (property.last_net_yield ?? 0), 0) / (analyzed.length || 1);
        const avgScore =
            analyzed.reduce((total, property) => total + (property.last_score ?? 0), 0) / (analyzed.length || 1);

        return {
            total: properties.length,
            analyzed: analyzed.length,
            stale: stale.length,
            avgNetYield: analyzed.length > 0 ? avgNetYield : null,
            avgScore: analyzed.length > 0 ? avgScore : null,
        };
    }, [properties]);

    const districts = useMemo(() => {
        return [...new Set(properties.map((property) => property.district))].sort((left, right) =>
            left.localeCompare(right)
        );
    }, [properties]);

    const filteredProperties = useMemo(() => {
        return screenWatchlistProperties(properties, {
            search,
            districtFilter,
            gradeFilter,
            analysisFilter,
            yieldMin,
            yieldMax,
            sortKey,
            sortDirection,
        });
    }, [analysisFilter, districtFilter, gradeFilter, properties, search, sortDirection, sortKey, yieldMax, yieldMin]);

    const toggleSortDirection = useCallback(() => {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    }, []);

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            <div className="flex flex-col gap-4 mb-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                            <Star className="w-5 h-5 text-amber-400" />
                        </div>
                        <div>
                            <h1 className="text-xl font-mono font-bold text-gray-200">Watchlist</h1>
                            <p className="text-xs text-gray-500 font-mono">
                                Track saved properties, review market drift, and jump into a property dossier.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleRefreshAll}
                            disabled={refreshAllActive || properties.length === 0}
                            className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 font-mono text-xs"
                        >
                            {refreshAllActive ? (
                                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                            ) : (
                                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            Refresh All
                        </Button>
                        <AddPropertyForm onAdd={handleAdd} />
                    </div>
                </div>

                {refreshAllProgress && (
                    <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                        <Badge variant="outline" className="border-cyan-500/20 bg-cyan-500/5 text-cyan-300">
                            Bulk refresh {refreshAllProgress.completed + refreshAllProgress.failed}/
                            {refreshAllProgress.total}
                        </Badge>
                        <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                            Success {refreshAllProgress.completed}
                        </Badge>
                        <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                            Failed {refreshAllProgress.failed}
                        </Badge>
                        {refreshAllActive && (
                            <Badge variant="outline" className="border-amber-500/20 bg-amber-500/5 text-amber-300">
                                Refreshing property #{refreshAllProgress.propertyId}
                            </Badge>
                        )}
                    </div>
                )}

                <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                    <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/5 text-emerald-300">
                        Compare picks {selectedCompareIds.length}/4
                    </Badge>
                    <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                        Unique districts {selectedCompareDistricts.length}
                    </Badge>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={openCompare}
                        disabled={selectedCompareIds.length < 2}
                        className="h-6 border-amber-500/30 px-2 text-[10px] font-mono text-amber-300 hover:bg-amber-500/10"
                    >
                        Open Compare
                    </Button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <SummaryMetric
                        label="Tracked"
                        value={formatNumber(summary.total)}
                        hint={`${formatNumber(summary.analyzed)} analyzed snapshots available`}
                    />
                    <SummaryMetric
                        label="Avg Net Yield"
                        value={formatYield(summary.avgNetYield)}
                        hint="Across properties with stored analysis"
                        tone="accent"
                    />
                    <SummaryMetric
                        label="Avg Score"
                        value={formatNumber(summary.avgScore)}
                        hint="Stored investment score average"
                        tone="warning"
                    />
                    <SummaryMetric
                        label="Needs Refresh"
                        value={formatNumber(summary.stale)}
                        hint="Older than 7 days or never analyzed"
                    />
                </div>
            </div>

            <Card className="border-white/5 bg-white/[0.02] mb-6">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-amber-400">Screening</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_repeat(6,minmax(0,1fr))] gap-3">
                        <div className="block">
                            <label
                                htmlFor="watchlist-search"
                                className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider"
                            >
                                Search
                            </label>
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
                                <Input
                                    id="watchlist-search"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder="Name, district, note, listing URL"
                                    className="h-9 pl-8 text-xs font-mono bg-black/20 border-white/10"
                                />
                            </div>
                        </div>

                        <label className="block">
                            <span className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                                District
                            </span>
                            <select
                                value={districtFilter}
                                onChange={(event) => setDistrictFilter(event.target.value)}
                                className="cyber-select"
                            >
                                <option value="all">All districts</option>
                                {districts.map((district) => (
                                    <option key={district} value={district}>
                                        {district}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="block">
                            <span className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                                Grade
                            </span>
                            <select
                                value={gradeFilter}
                                onChange={(event) => setGradeFilter(event.target.value)}
                                className="cyber-select"
                            >
                                <option value="all">All grades</option>
                                <option value="A-B">A-B</option>
                                <option value="A-C">A-C</option>
                                <option value="B-D">B-D</option>
                                <option value="D-F">D-F</option>
                                <option value="A">A</option>
                                <option value="B">B</option>
                                <option value="C">C</option>
                                <option value="D">D</option>
                                <option value="F">F</option>
                                <option value="ungraded">Ungraded</option>
                            </select>
                        </label>

                        <div className="grid grid-cols-2 gap-2">
                            <label className="block">
                                <span className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                                    Yield Min
                                </span>
                                <Input
                                    value={yieldMin}
                                    onChange={(event) => setYieldMin(event.target.value)}
                                    placeholder="3.5"
                                    type="number"
                                    className="h-9 text-xs font-mono bg-black/20 border-white/10"
                                />
                            </label>
                            <label className="block">
                                <span className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                                    Yield Max
                                </span>
                                <Input
                                    value={yieldMax}
                                    onChange={(event) => setYieldMax(event.target.value)}
                                    placeholder="6"
                                    type="number"
                                    className="h-9 text-xs font-mono bg-black/20 border-white/10"
                                />
                            </label>
                        </div>

                        <label className="block">
                            <span className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                                Analysis
                            </span>
                            <select
                                value={analysisFilter}
                                onChange={(event) => setAnalysisFilter(event.target.value)}
                                className="cyber-select"
                            >
                                <option value="all">All</option>
                                <option value="fresh">Fresh</option>
                                <option value="stale">Needs refresh</option>
                            </select>
                        </label>

                        <label className="block">
                            <span className="block text-[10px] font-mono text-gray-500 mb-1 uppercase tracking-wider">
                                Sort
                            </span>
                            <div className="flex gap-2">
                                <select
                                    value={sortKey}
                                    onChange={(event) => setSortKey(event.target.value as WatchlistSortKey)}
                                    className="cyber-select"
                                >
                                    <option value="name">Name</option>
                                    <option value="updated">Last analyzed</option>
                                    <option value="grade">Grade</option>
                                    <option value="yield">Net yield</option>
                                    <option value="percentile">Percentile</option>
                                    <option value="score">Score</option>
                                    <option value="price">Target price</option>
                                    <option value="district">District</option>
                                </select>
                                <button
                                    type="button"
                                    onClick={toggleSortDirection}
                                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-black/20 text-gray-400 hover:text-amber-400 hover:border-amber-500/30"
                                    aria-label="Toggle sort direction"
                                >
                                    {sortDirection === "asc" ? (
                                        <ArrowUpAZ className="h-4 w-4" />
                                    ) : (
                                        <ArrowDownAZ className="h-4 w-4" />
                                    )}
                                </button>
                            </div>
                        </label>
                    </div>

                    <div className="flex flex-wrap gap-2 text-[10px] font-mono">
                        <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                            Showing {formatNumber(filteredProperties.length)} of {formatNumber(properties.length)}
                        </Badge>
                        <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                            Target value{" "}
                            {formatCurrencyCompact(
                                properties.reduce((sum, property) => sum + property.target_price, 0)
                            )}
                        </Badge>
                        <Badge variant="outline" className="border-white/10 bg-white/[0.02] text-gray-400">
                            Avg rent{" "}
                            {formatCurrencyCompact(
                                properties.reduce((sum, property) => sum + property.monthly_rent, 0) /
                                    (properties.length || 1)
                            )}
                        </Badge>
                    </div>
                </CardContent>
            </Card>

            {propertiesLoading && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {WATCHLIST_SKELETON_KEYS.map((key) => (
                        <div key={key} className="border border-white/5 rounded-lg p-4 space-y-3">
                            <Skeleton variant="default" className="h-4 w-2/3" />
                            <Skeleton variant="default" className="h-3 w-1/2" />
                            <div className="grid grid-cols-2 gap-2">
                                <Skeleton variant="default" className="h-16 w-full" />
                                <Skeleton variant="default" className="h-16 w-full" />
                            </div>
                            <Skeleton variant="default" className="h-8 w-full" />
                        </div>
                    ))}
                </div>
            )}

            {!propertiesLoading && filteredProperties.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filteredProperties.map((property) => (
                        <PropertyCard
                            key={property.id}
                            property={property}
                            history={historyByProperty[property.id] ?? []}
                            onRefresh={handleRefresh}
                            onDelete={handleDelete}
                            onUpdateAlerts={handleUpdateAlerts}
                            selectedForCompare={selectedCompareIds.includes(property.id)}
                            onToggleCompare={toggleCompareSelection}
                        />
                    ))}
                </div>
            )}

            {!propertiesLoading && properties.length === 0 && (
                <div className="border border-white/5 rounded-xl p-12 text-center glass-card">
                    <div className="w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
                        <Star className="w-6 h-6 text-amber-500/60" />
                    </div>
                    <p className="text-sm text-gray-400 font-mono font-semibold mb-1">No properties in watchlist</p>
                    <p className="text-xs text-gray-600 font-mono">
                        Add a property to track its investment metrics over time
                    </p>
                </div>
            )}

            {!propertiesLoading && properties.length > 0 && filteredProperties.length === 0 && (
                <div className="border border-white/5 rounded-xl p-12 text-center glass-card">
                    <p className="text-sm text-gray-400 font-mono font-semibold mb-1">
                        No properties match the current filters
                    </p>
                    <p className="text-xs text-gray-600 font-mono">
                        Broaden the search or reset one of the screening controls above.
                    </p>
                </div>
            )}
        </div>
    );
}
