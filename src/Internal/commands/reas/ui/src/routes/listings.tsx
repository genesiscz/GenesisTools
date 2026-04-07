import { PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { toast } from "@ui/index";
import { cn } from "@ui/lib/utils";
import { Building2, ChevronDown, RefreshCw } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { ListingDetailSheet } from "../components/listings/ListingDetailSheet";
import { ListingFilters } from "../components/listings/ListingFilters";
import { ListingsTable } from "../components/listings/ListingsTable";
import {
    appendFilterParams,
    countActiveFilters,
    DEFAULT_FILTERS,
    formatShortDateTime,
    LISTING_TYPES,
    type ListingsFilters,
    type ListingsResponse,
    type ListingType,
    normalizeFilters,
    SORT_OPTIONS,
    type SortBy,
    type SortDir,
} from "../components/listings/listings-shared";
import { SourceBadge } from "../components/listings/SourceBadge";
import { StalenessIndicator } from "../components/StalenessIndicator";

export const Route = createFileRoute("/listings")({
    component: ListingsPage,
});

function ListingsPage() {
    const queryClient = useQueryClient();
    const [listingType, setListingType] = useState<ListingType>("sale");
    const [draftFilters, setDraftFilters] = useState<ListingsFilters>(DEFAULT_FILTERS);
    const [filters, setFilters] = useState<ListingsFilters>(DEFAULT_FILTERS);
    const [fetchConstructionType, setFetchConstructionType] = useState(
        PROPERTY_TYPES[1]?.value ?? PROPERTY_TYPES[0].value
    );
    const [page, setPage] = useState(1);
    const [sortBy, setSortBy] = useState<SortBy>("fetched_at");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [selectedListingId, setSelectedListingId] = useState<number | null>(null);

    const listingsQuery = useQuery<ListingsResponse>({
        queryKey: ["listings", listingType, filters, page, sortBy, sortDir],
        queryFn: async () => {
            const params = new URLSearchParams({
                type: listingType,
                page: String(page),
                limit: "25",
                sortBy,
                sortDir,
            });

            appendFilterParams(params, filters);

            const response = await fetch(`/api/listings?${params.toString()}`);

            if (!response.ok) {
                throw new Error(`Failed to fetch listings (${response.status})`);
            }

            return response.json() as Promise<ListingsResponse>;
        },
    });

    const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);
    const listings = listingsQuery.data?.listings ?? [];
    const overview = listingsQuery.data?.overview;
    const totalPages = listingsQuery.data?.totalPages ?? 1;
    const selectedFreshness = getTypeFreshness(overview, listingType);
    const sourceOptions = useMemo(() => {
        const defaultSources = ["sreality", "bezrealitky", "ereality", "reas", "mf"];
        const knownSources = overview?.sources.map((source) => source.source) ?? [];
        return Array.from(new Set([...knownSources, ...defaultSources])).sort((left, right) =>
            left.localeCompare(right)
        );
    }, [overview]);

    const fetchListingsMutation = useMutation({
        mutationFn: async () => {
            const nextFilters = normalizeFilters(draftFilters);
            const response = await fetch("/api/listings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify({
                    type: listingType,
                    district: nextFilters.district,
                    disposition: nextFilters.dispositions.length === 1 ? nextFilters.dispositions[0] : undefined,
                    source: nextFilters.sources.length === 1 ? nextFilters.sources[0] : undefined,
                    priceMin: nextFilters.priceMin,
                    priceMax: nextFilters.priceMax,
                    areaMin: nextFilters.areaMin,
                    areaMax: nextFilters.areaMax,
                    constructionType: fetchConstructionType,
                }),
            });

            const body = (await response.json()) as {
                error?: string;
                fetchedCount?: number;
                district?: string;
                type?: ListingType;
                warnings?: string[];
            };

            if (!response.ok) {
                throw new Error(body.error ?? "Failed to fetch listings");
            }

            return body;
        },
        onSuccess: async (result) => {
            setFilters(normalizeFilters(draftFilters));
            setPage(1);
            await queryClient.invalidateQueries({ queryKey: ["listings"] });

            const listingLabel = result.type === "sold" ? "sold" : result.type === "rental" ? "rental" : "sale";
            const warningSuffix =
                result.warnings && result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : "";
            toast.success(
                `Fetched ${result.fetchedCount ?? 0} ${listingLabel} listings for ${result.district ?? "selected district"}${warningSuffix}`
            );
        },
        onError: (error: Error) => {
            toast.error(error.message);
        },
    });

    const handleNumberFilterChange = (key: "priceMin" | "priceMax" | "areaMin" | "areaMax", value: string) => {
        setDraftFilters((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const handleToggleDisposition = (value: string) => {
        setDraftFilters((current) => ({
            ...current,
            dispositions: current.dispositions.includes(value)
                ? current.dispositions.filter((item) => item !== value)
                : [...current.dispositions, value],
        }));
    };

    const handleToggleSource = (value: string) => {
        setDraftFilters((current) => ({
            ...current,
            sources: current.sources.includes(value)
                ? current.sources.filter((item) => item !== value)
                : [...current.sources, value],
        }));
    };

    const handleDateRangeChange = (range: { from: string; to: string }) => {
        setDraftFilters((current) => ({
            ...current,
            seenFrom: range.from,
            seenTo: range.to,
        }));
    };

    const handleApplyFilters = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setFilters(normalizeFilters(draftFilters));
        setPage(1);
    };

    const handleResetFilters = () => {
        setDraftFilters(DEFAULT_FILTERS);
        setFilters(DEFAULT_FILTERS);
        setPage(1);
    };

    const handleTypeChange = (value: string) => {
        const nextType = value as ListingType;
        setListingType(nextType);
        setPage(1);

        if (nextType === "sold" && sortBy === "fetched_at") {
            setSortBy("sold_at");
        }

        if (nextType !== "sold" && sortBy === "sold_at") {
            setSortBy("fetched_at");
        }
    };

    return (
        <>
            <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
                <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="flex items-center gap-3">
                        <div className="rounded bg-amber-500/10 p-2 border border-amber-500/30">
                            <Building2 className="h-5 w-5 text-amber-400" />
                        </div>
                        <div>
                            <h1 className="text-xl font-mono font-bold text-gray-200">Listings</h1>
                            <p className="text-xs font-mono text-gray-500">
                                Browse cached sale, rental, and sold inventory persisted from prior REAS analyses.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 justify-end">
                        <div className="flex items-center gap-2">
                            <Select value={fetchConstructionType} onValueChange={setFetchConstructionType}>
                                <SelectTrigger className="h-9 w-[140px] border-white/10 bg-white/[0.02] text-xs font-mono text-gray-300">
                                    <SelectValue placeholder="Structure" />
                                </SelectTrigger>
                                <SelectContent>
                                    {PROPERTY_TYPES.map((type) => (
                                        <SelectItem key={type.value} value={type.value}>
                                            {type.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button
                                variant="outline"
                                className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                                onClick={() => fetchListingsMutation.mutate()}
                                disabled={fetchListingsMutation.isPending}
                            >
                                <RefreshCw
                                    className={cn("h-4 w-4", fetchListingsMutation.isPending && "animate-spin")}
                                />
                                Fetch Listings
                            </Button>
                        </div>
                        {selectedFreshness && <StalenessIndicator generatedAt={selectedFreshness} />}
                        <Badge
                            variant="outline"
                            className="border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.2em] text-gray-300"
                        >
                            {listingsQuery.data?.total ?? 0} matches
                        </Badge>
                        <Badge
                            variant="outline"
                            className="border-cyan-500/20 bg-cyan-500/5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-300"
                        >
                            {activeFilterCount} filters
                        </Badge>
                    </div>
                </div>

                {overview && (
                    <Card className="mb-6 border-white/5 bg-white/[0.02]">
                        <CardHeader className="border-b border-white/5 pb-4">
                            <CardTitle className="font-mono text-sm text-cyan-300">Cache overview</CardTitle>
                            <CardDescription className="font-mono text-xs text-gray-500">
                                Active tabs only show listings already ingested into the local SQLite cache. They do not
                                fetch marketplace inventory on page load.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-5 pt-6">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                    variant="outline"
                                    className="border-cyan-500/20 bg-cyan-500/5 font-mono text-[10px] text-cyan-300"
                                >
                                    {overview.saleCount} sale
                                </Badge>
                                <Badge
                                    variant="outline"
                                    className="border-emerald-500/20 bg-emerald-500/5 font-mono text-[10px] text-emerald-300"
                                >
                                    {overview.rentalCount} rental
                                </Badge>
                                <Badge
                                    variant="outline"
                                    className="border-amber-500/20 bg-amber-500/5 font-mono text-[10px] text-amber-300"
                                >
                                    {overview.soldCount} sold
                                </Badge>
                                <Badge
                                    variant="outline"
                                    className="border-white/10 bg-white/[0.03] font-mono text-[10px] text-gray-300"
                                >
                                    {overview.sourceCount} cached sources
                                </Badge>
                                {overview.lastFetchedAt && (
                                    <Badge
                                        variant="outline"
                                        className="border-white/10 bg-white/[0.03] font-mono text-[10px] text-gray-300"
                                    >
                                        Last updated {formatShortDateTime(overview.lastFetchedAt)}
                                    </Badge>
                                )}
                            </div>

                            {overview.sources.length > 0 && (
                                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                    {overview.sources.map((source) => (
                                        <div
                                            key={source.source}
                                            className="rounded-xl border border-white/5 bg-black/20 p-3"
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <SourceBadge source={source.source} />
                                                <span className="font-mono text-[10px] text-gray-500">
                                                    {source.count} rows
                                                </span>
                                            </div>
                                            <div className="mt-3 flex items-center justify-between gap-2">
                                                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gray-600">
                                                    Freshness
                                                </span>
                                                {source.lastFetchedAt ? (
                                                    <StalenessIndicator generatedAt={source.lastFetchedAt} />
                                                ) : (
                                                    <Badge
                                                        variant="outline"
                                                        className="border-white/10 bg-white/[0.03] font-mono text-[10px] text-gray-500"
                                                    >
                                                        never
                                                    </Badge>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {overview.districtSources && overview.districtSources.length > 0 && (
                                <DistrictSourceBreakdown districtSources={overview.districtSources} />
                            )}
                        </CardContent>
                    </Card>
                )}

                <Tabs value={listingType} onValueChange={handleTypeChange} className="mb-6">
                    <TabsList className="bg-white/[0.02]">
                        {LISTING_TYPES.map((type) => (
                            <TabsTrigger
                                key={type.value}
                                value={type.value}
                                className="font-mono text-xs uppercase tracking-[0.18em] data-[state=active]:bg-amber-500/10 data-[state=active]:text-amber-300"
                            >
                                {type.label}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>

                <ListingFilters
                    filters={draftFilters}
                    sourceOptions={sourceOptions}
                    sortBy={sortBy}
                    sortDir={sortDir}
                    totalPages={totalPages}
                    page={page}
                    onDistrictChange={(value) => {
                        setDraftFilters((current) => ({
                            ...current,
                            district: value,
                        }));
                    }}
                    onToggleDisposition={handleToggleDisposition}
                    onToggleSource={handleToggleSource}
                    onDateRangeChange={handleDateRangeChange}
                    onNumberFilterChange={handleNumberFilterChange}
                    onSubmit={handleApplyFilters}
                    onReset={handleResetFilters}
                    onSortByChange={setSortBy}
                    onSortDirChange={setSortDir}
                    sortOptions={SORT_OPTIONS}
                />

                <ListingsTable
                    listingType={listingType}
                    listings={listings}
                    isLoading={listingsQuery.isLoading}
                    isError={listingsQuery.isError}
                    errorMessage={listingsQuery.isError ? listingsQuery.error.message : undefined}
                    isRefreshing={listingsQuery.isFetching}
                    sortBy={sortBy}
                    sortDir={sortDir}
                    page={page}
                    totalPages={totalPages}
                    total={listingsQuery.data?.total ?? 0}
                    limit={listingsQuery.data?.limit ?? 25}
                    onRefresh={() => listingsQuery.refetch()}
                    onSelectListing={setSelectedListingId}
                    onPageChange={setPage}
                />
            </div>

            <ListingDetailSheet
                listingId={selectedListingId}
                open={selectedListingId !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setSelectedListingId(null);
                    }
                }}
            />
        </>
    );
}

function getTypeFreshness(
    overview:
        | {
              saleLastFetchedAt: string | null;
              rentalLastFetchedAt: string | null;
              soldLastFetchedAt: string | null;
          }
        | undefined,
    listingType: ListingType
): string | null {
    if (!overview) {
        return null;
    }

    if (listingType === "sale") {
        return overview.saleLastFetchedAt;
    }

    if (listingType === "rental") {
        return overview.rentalLastFetchedAt;
    }

    return overview.soldLastFetchedAt;
}

interface DistrictSourceEntry {
    district: string;
    source: string;
    type: string;
    count: number;
    lastFetchedAt: string | null;
}

function DistrictSourceBreakdown({ districtSources }: { districtSources: DistrictSourceEntry[] }) {
    const [expanded, setExpanded] = useState(false);

    const grouped = useMemo(() => {
        const map = new Map<string, DistrictSourceEntry[]>();

        for (const row of districtSources) {
            const existing = map.get(row.district);

            if (existing) {
                existing.push(row);
            } else {
                map.set(row.district, [row]);
            }
        }

        return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, "cs"));
    }, [districtSources]);

    const uniqueDistricts = grouped.length;
    const displayRows = expanded ? grouped : grouped.slice(0, 6);

    return (
        <div className="space-y-3">
            <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => setExpanded(!expanded)}
            >
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gray-500">
                    Per-district breakdown · {uniqueDistricts} districts
                </span>
                <ChevronDown
                    className={cn("h-3.5 w-3.5 text-gray-500 transition-transform", expanded && "rotate-180")}
                />
            </button>

            <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                    <thead>
                        <tr className="border-b border-white/5 text-left text-[9px] uppercase tracking-[0.2em] text-gray-600">
                            <th className="px-2 py-1.5">District</th>
                            <th className="px-2 py-1.5">Source</th>
                            <th className="px-2 py-1.5">Type</th>
                            <th className="px-2 py-1.5 text-right">Count</th>
                            <th className="px-2 py-1.5 text-right">Last fetched</th>
                        </tr>
                    </thead>
                    <tbody>
                        {displayRows.map(([district, entries]) =>
                            entries.map((entry, idx) => (
                                <tr
                                    key={`${district}-${entry.source}-${entry.type}`}
                                    className="border-b border-white/[0.03] transition-colors hover:bg-white/[0.02]"
                                >
                                    <td className="px-2 py-1.5 text-gray-200">{idx === 0 ? district : ""}</td>
                                    <td className="px-2 py-1.5">
                                        <SourceBadge source={entry.source} />
                                    </td>
                                    <td className="px-2 py-1.5 text-gray-400">{entry.type}</td>
                                    <td className="px-2 py-1.5 text-right text-white">{entry.count}</td>
                                    <td className="px-2 py-1.5 text-right text-gray-500">
                                        {entry.lastFetchedAt ? formatShortDateTime(entry.lastFetchedAt) : "never"}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {!expanded && grouped.length > 6 && (
                <button
                    type="button"
                    className="w-full text-center font-mono text-[10px] text-cyan-400 hover:text-cyan-300 transition-colors"
                    onClick={() => setExpanded(true)}
                >
                    Show all {uniqueDistricts} districts
                </button>
            )}
        </div>
    );
}
