import type { GetListingsOptions, ListingRow } from "@app/Internal/commands/reas/lib/store";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Pagination, PaginationContent, PaginationItem } from "@ui/components/pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib/utils";
import { Building2, ExternalLink, Filter, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type FormEvent, type HTMLInputTypeAttribute, useMemo, useState } from "react";
import { ListingDetailSheet } from "../components/listings/ListingDetailSheet";

export const Route = createFileRoute("/listings")({
    component: ListingsPage,
});

type ListingType = "sale" | "rental" | "sold";
type SortBy = NonNullable<GetListingsOptions["sortBy"]>;
type SortDir = NonNullable<GetListingsOptions["sortDir"]>;

interface ListingsFilters {
    district: string;
    disposition: string;
    source: string;
    priceMin: string;
    priceMax: string;
    areaMin: string;
    areaMax: string;
}

interface ListingsResponse {
    listings: ListingRow[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

const DEFAULT_FILTERS: ListingsFilters = {
    district: "",
    disposition: "",
    source: "",
    priceMin: "",
    priceMax: "",
    areaMin: "",
    areaMax: "",
};

const LISTING_TYPES: Array<{ value: ListingType; label: string }> = [
    { value: "sale", label: "Sale" },
    { value: "rental", label: "Rental" },
    { value: "sold", label: "Sold" },
];

const SORT_OPTIONS: Array<{ value: SortBy; label: string }> = [
    { value: "fetched_at", label: "Fetched at" },
    { value: "sold_at", label: "Sold at" },
    { value: "price", label: "Price" },
    { value: "price_per_m2", label: "Price / m2" },
    { value: "area", label: "Area" },
];

const SOURCE_STYLES: Record<string, string> = {
    sreality: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    bezrealitky: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    ereality: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    "mf-rental": "border-amber-500/30 bg-amber-500/10 text-amber-300",
    reas: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

const LISTING_SKELETON_KEYS = ["one", "two", "three", "four", "five", "six", "seven", "eight"] as const;

function ListingsPage() {
    const [listingType, setListingType] = useState<ListingType>("sale");
    const [draftFilters, setDraftFilters] = useState<ListingsFilters>(DEFAULT_FILTERS);
    const [filters, setFilters] = useState<ListingsFilters>(DEFAULT_FILTERS);
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
    const totalPages = listingsQuery.data?.totalPages ?? 1;

    const handleFilterChange = (key: keyof ListingsFilters, value: string) => {
        setDraftFilters((current) => ({
            ...current,
            [key]: value,
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
                                Browse live sale, rental, and sold inventory from the aggregated REAS feeds.
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
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

                <Card className="mb-6 border-white/5 bg-white/[0.02]">
                    <CardHeader className="border-b border-white/5 pb-4">
                        <CardTitle className="flex items-center gap-2 font-mono text-sm text-amber-300">
                            <Filter className="h-4 w-4" />
                            Filters
                        </CardTitle>
                        <CardDescription className="font-mono text-xs text-gray-500">
                            Narrow the browser by location, source, and price or area bands.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="pt-6">
                        <form className="space-y-4" onSubmit={handleApplyFilters}>
                            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <FilterInput
                                    label="District"
                                    value={draftFilters.district}
                                    onChange={(value) => handleFilterChange("district", value)}
                                    placeholder="Praha 2"
                                />
                                <FilterInput
                                    label="Disposition"
                                    value={draftFilters.disposition}
                                    onChange={(value) => handleFilterChange("disposition", value)}
                                    placeholder="2+kk"
                                />
                                <FilterInput
                                    label="Source"
                                    value={draftFilters.source}
                                    onChange={(value) => handleFilterChange("source", value)}
                                    placeholder="sreality"
                                />
                                <div className="grid grid-cols-2 gap-3">
                                    <FilterInput
                                        label="Min price"
                                        value={draftFilters.priceMin}
                                        onChange={(value) => handleFilterChange("priceMin", value)}
                                        placeholder="2500000"
                                        type="number"
                                    />
                                    <FilterInput
                                        label="Max price"
                                        value={draftFilters.priceMax}
                                        onChange={(value) => handleFilterChange("priceMax", value)}
                                        placeholder="8000000"
                                        type="number"
                                    />
                                </div>
                                <div className="grid grid-cols-2 gap-3 md:col-span-2 xl:col-span-1">
                                    <FilterInput
                                        label="Min area"
                                        value={draftFilters.areaMin}
                                        onChange={(value) => handleFilterChange("areaMin", value)}
                                        placeholder="45"
                                        type="number"
                                    />
                                    <FilterInput
                                        label="Max area"
                                        value={draftFilters.areaMax}
                                        onChange={(value) => handleFilterChange("areaMax", value)}
                                        placeholder="120"
                                        type="number"
                                    />
                                </div>
                                <SelectField
                                    label="Sort by"
                                    value={sortBy}
                                    onChange={(value) => setSortBy(value as SortBy)}
                                    options={SORT_OPTIONS}
                                />
                                <SelectField
                                    label="Direction"
                                    value={sortDir}
                                    onChange={(value) => setSortDir(value as SortDir)}
                                    options={[
                                        { value: "desc", label: "Descending" },
                                        { value: "asc", label: "Ascending" },
                                    ]}
                                />
                            </div>

                            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-4">
                                <p className="font-mono text-[11px] text-gray-500">
                                    Page {page} of {totalPages}
                                </p>
                                <div className="flex items-center gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                                        onClick={handleResetFilters}
                                    >
                                        Reset
                                    </Button>
                                    <Button
                                        type="submit"
                                        className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                                    >
                                        Apply filters
                                    </Button>
                                </div>
                            </div>
                        </form>
                    </CardContent>
                </Card>

                <Card className="border-white/5 bg-white/[0.02]">
                    <CardHeader className="border-b border-white/5 pb-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 font-mono text-sm text-amber-300">
                                    <SlidersHorizontal className="h-4 w-4" />
                                    Listing table
                                </CardTitle>
                                <CardDescription className="font-mono text-xs text-gray-500">
                                    Sorted by {readableSortLabel(sortBy)} in {sortDir} order.
                                </CardDescription>
                            </div>
                            <Button
                                variant="outline"
                                className="border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                                onClick={() => listingsQuery.refetch()}
                            >
                                <RefreshCw className={cn("h-4 w-4", listingsQuery.isFetching && "animate-spin")} />
                                Refresh
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="pt-6">
                        {listingsQuery.isLoading && <ListingsTableSkeleton />}

                        {listingsQuery.isError && (
                            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 font-mono text-sm text-red-300">
                                {listingsQuery.error.message}
                            </div>
                        )}

                        {!listingsQuery.isLoading && !listingsQuery.isError && listings.length === 0 && (
                            <div className="rounded-xl border border-white/5 bg-black/20 px-6 py-14 text-center">
                                <p className="font-mono text-sm text-gray-300">
                                    No listings matched the current filters.
                                </p>
                                <p className="mt-2 font-mono text-xs text-gray-500">
                                    Reset the form or switch tabs to explore other inventory.
                                </p>
                            </div>
                        )}

                        {!listingsQuery.isLoading && !listingsQuery.isError && listings.length > 0 && (
                            <>
                                <Table>
                                    <TableHeader>
                                        <TableRow className="border-white/5 hover:bg-transparent">
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">
                                                Source
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">
                                                Address
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">
                                                District
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">
                                                Disp.
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-right text-gray-500">
                                                Area
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-right text-gray-500">
                                                Price
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-right text-gray-500">
                                                Price / m2
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-right text-gray-500">
                                                Market
                                            </TableHead>
                                            <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-right text-gray-500">
                                                Seen
                                            </TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {listings.map((listing) => (
                                            <TableRow key={listing.id} className="border-white/5 hover:bg-white/[0.03]">
                                                <TableCell>
                                                    <Badge
                                                        variant="outline"
                                                        className={cn(
                                                            "text-[10px] font-mono uppercase tracking-[0.16em]",
                                                            getSourceStyle(listing.source)
                                                        )}
                                                    >
                                                        {listing.source}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="max-w-[280px] whitespace-normal">
                                                    <div className="flex items-start gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => setSelectedListingId(listing.id)}
                                                            className="text-left font-mono text-xs text-gray-100 transition-colors hover:text-amber-300"
                                                        >
                                                            {listing.address}
                                                        </button>
                                                        <a
                                                            href={listing.link}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="mt-0.5 text-gray-500 transition-colors hover:text-cyan-300"
                                                            aria-label={`Open ${listing.address} source listing`}
                                                        >
                                                            <ExternalLink className="h-3.5 w-3.5" />
                                                        </a>
                                                    </div>
                                                    <div className="mt-1 text-[11px] font-mono text-gray-500">
                                                        {listing.status}
                                                    </div>
                                                </TableCell>
                                                <TableCell className="font-mono text-xs text-gray-300">
                                                    {listing.district}
                                                </TableCell>
                                                <TableCell className="font-mono text-xs text-gray-400">
                                                    {listing.disposition ?? "--"}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs text-gray-300">
                                                    {formatArea(listing.area)}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs text-amber-300">
                                                    {formatPrice(listing.price)}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs text-cyan-300">
                                                    {formatPricePerM2(listing.price_per_m2)}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs text-gray-400">
                                                    {formatMarketMetric(listing.days_on_market)}
                                                </TableCell>
                                                <TableCell className="text-right font-mono text-xs text-gray-400">
                                                    {formatShortDate(
                                                        listing.type === "sold" ? listing.sold_at : listing.fetched_at
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>

                                <div className="mt-4 flex flex-col gap-3 border-t border-white/5 pt-4 md:flex-row md:items-center md:justify-between">
                                    <div className="font-mono text-[11px] text-gray-500">
                                        Showing {(page - 1) * (listingsQuery.data?.limit ?? 25) + 1} -{" "}
                                        {Math.min(
                                            page * (listingsQuery.data?.limit ?? 25),
                                            listingsQuery.data?.total ?? 0
                                        )}{" "}
                                        of {listingsQuery.data?.total ?? 0}
                                    </div>
                                    <Pagination className="mx-0 w-auto justify-start md:justify-end">
                                        <PaginationContent>
                                            <PaginationItem>
                                                <Button
                                                    variant="outline"
                                                    className="border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                                                    disabled={page <= 1}
                                                    onClick={() => setPage((current) => Math.max(current - 1, 1))}
                                                >
                                                    Previous
                                                </Button>
                                            </PaginationItem>
                                            <PaginationItem>
                                                <Badge
                                                    variant="outline"
                                                    className="border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-gray-300"
                                                >
                                                    {page} / {totalPages}
                                                </Badge>
                                            </PaginationItem>
                                            <PaginationItem>
                                                <Button
                                                    variant="outline"
                                                    className="border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                                                    disabled={page >= totalPages}
                                                    onClick={() =>
                                                        setPage((current) => Math.min(current + 1, totalPages))
                                                    }
                                                >
                                                    Next
                                                </Button>
                                            </PaginationItem>
                                        </PaginationContent>
                                    </Pagination>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
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

function FilterInput({
    label,
    value,
    onChange,
    placeholder,
    type = "text",
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    type?: HTMLInputTypeAttribute;
}) {
    return (
        <div className="block">
            <span className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">{label}</span>
            <Input
                type={type}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                className="border-white/10 bg-black/20 font-mono text-xs text-gray-200 placeholder:text-gray-600"
            />
        </div>
    );
}

function SelectField({
    label,
    value,
    onChange,
    options,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
}) {
    return (
        <div className="block">
            <span className="mb-1.5 block text-[10px] font-mono uppercase tracking-[0.2em] text-gray-500">{label}</span>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger className="border-white/10 bg-black/20 font-mono text-xs text-gray-200 hover:border-white/20 focus:border-amber-500/40">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#09090d] font-mono text-xs text-gray-200">
                    {options.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="font-mono text-xs text-gray-200">
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

function ListingsTableSkeleton() {
    return (
        <div className="space-y-3">
            {LISTING_SKELETON_KEYS.map((key) => (
                <Skeleton key={key} variant="default" className="h-10 w-full" />
            ))}
        </div>
    );
}

function appendFilterParams(params: URLSearchParams, filters: ListingsFilters) {
    const normalized = normalizeFilters(filters);

    for (const [key, value] of Object.entries(normalized)) {
        if (value) {
            params.set(key, value);
        }
    }
}

function normalizeFilters(filters: ListingsFilters): ListingsFilters {
    return {
        district: filters.district.trim(),
        disposition: filters.disposition.trim(),
        source: filters.source.trim(),
        priceMin: filters.priceMin.trim(),
        priceMax: filters.priceMax.trim(),
        areaMin: filters.areaMin.trim(),
        areaMax: filters.areaMax.trim(),
    };
}

function countActiveFilters(filters: ListingsFilters) {
    return Object.values(normalizeFilters(filters)).filter(Boolean).length;
}

function readableSortLabel(sortBy: SortBy) {
    return SORT_OPTIONS.find((option) => option.value === sortBy)?.label.toLowerCase() ?? sortBy;
}

function getSourceStyle(source: string) {
    return SOURCE_STYLES[source] ?? "border-white/10 bg-white/[0.03] text-gray-300";
}

function formatPrice(value: number) {
    return `${value.toLocaleString("cs-CZ")} CZK`;
}

function formatPricePerM2(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} CZK`;
}

function formatArea(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} m2`;
}

function formatMarketMetric(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${Math.round(value)} d`;
}

function formatShortDate(value: string | null) {
    if (!value) {
        return "--";
    }

    return new Intl.DateTimeFormat("cs-CZ", {
        dateStyle: "medium",
    }).format(new Date(value));
}
