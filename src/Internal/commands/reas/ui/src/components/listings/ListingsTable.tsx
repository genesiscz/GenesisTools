import type { ListingRow } from "@app/Internal/commands/reas/lib/store";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/components/card";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Pagination, PaginationContent, PaginationItem } from "@ui/components/pagination";
import { Skeleton } from "@ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/components/table";
import { cn } from "@ui/lib/utils";
import { ExternalLink, MoreHorizontal, RefreshCw, SlidersHorizontal } from "lucide-react";
import { StalenessIndicator } from "../StalenessIndicator";
import {
    formatArea,
    formatMarketMetric,
    formatPrice,
    formatPricePerM2,
    formatShortDate,
    getListingRangeLabel,
    LISTING_SKELETON_KEYS,
    type ListingType,
    readableSortLabel,
    type SortBy,
    type SortDir,
} from "./listings-shared";
import { SourceBadge } from "./SourceBadge";

interface ListingsTableProps {
    listingType: ListingType;
    listings: ListingRow[];
    isLoading: boolean;
    isError: boolean;
    errorMessage?: string;
    isRefreshing: boolean;
    sortBy: SortBy;
    sortDir: SortDir;
    page: number;
    totalPages: number;
    total: number;
    limit: number;
    onRefresh: () => void;
    onSelectListing: (listingId: number) => void;
    onPageChange: (page: number) => void;
}

export function ListingsTable({
    listingType,
    listings,
    isLoading,
    isError,
    errorMessage,
    isRefreshing,
    sortBy,
    sortDir,
    page,
    totalPages,
    total,
    limit,
    onRefresh,
    onSelectListing,
    onPageChange,
}: ListingsTableProps) {
    return (
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
                        onClick={onRefresh}
                    >
                        <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
                        Refresh
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="pt-6">
                {listingType !== "sold" && total <= 5 && !isLoading && !isError && (
                    <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 font-mono text-xs text-amber-200">
                        This active tab is sparse because only previously ingested listings are available in the cache
                        right now. Run a fresh analysis or refresh tracked properties to ingest more active inventory.
                    </div>
                )}

                {isLoading && <ListingsTableSkeleton />}

                {isError && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 font-mono text-sm text-red-300">
                        {errorMessage ?? "Failed to load listings."}
                    </div>
                )}

                {!isLoading && !isError && listings.length === 0 && (
                    <div className="rounded-xl border border-white/5 bg-black/20 px-6 py-14 text-center">
                        <p className="font-mono text-sm text-gray-300">No listings matched the current filters.</p>
                        <p className="mt-2 font-mono text-xs text-gray-500">
                            Reset the form or switch tabs to explore other inventory.
                        </p>
                    </div>
                )}

                {!isLoading && !isError && listings.length > 0 && (
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
                                    <TableHead className="text-[10px] font-mono uppercase tracking-[0.2em] text-right text-gray-500">
                                        Actions
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {listings.map((listing) => (
                                    <TableRow
                                        key={listing.id}
                                        tabIndex={0}
                                        className="cursor-pointer border-white/5 hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none"
                                        onClick={() => onSelectListing(listing.id)}
                                        onKeyDown={(event) => {
                                            if (isNestedInteractiveTarget(event.target)) {
                                                return;
                                            }

                                            if (event.key !== "Enter" && event.key !== " ") {
                                                return;
                                            }

                                            event.preventDefault();
                                            onSelectListing(listing.id);
                                        }}
                                    >
                                        <TableCell>
                                            <div className="flex flex-col items-start gap-2">
                                                <SourceBadge source={listing.source} href={listing.link} />
                                                <Badge
                                                    variant="outline"
                                                    className={cn(
                                                        "text-[10px] font-mono uppercase tracking-[0.18em]",
                                                        listing.status === "sold" &&
                                                            "border-amber-500/30 bg-amber-500/10 text-amber-300",
                                                        listing.status === "active" &&
                                                            "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                                                        listing.status === "removed" &&
                                                            "border-red-500/30 bg-red-500/10 text-red-300"
                                                    )}
                                                >
                                                    {listing.status}
                                                </Badge>
                                            </div>
                                        </TableCell>
                                        <TableCell className="max-w-[280px] whitespace-normal">
                                            <div className="flex items-start gap-2">
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        onSelectListing(listing.id);
                                                    }}
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
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                    }}
                                                >
                                                    <ExternalLink className="h-3.5 w-3.5" />
                                                </a>
                                            </div>
                                            <div className="mt-1 text-[11px] font-mono text-gray-500">
                                                {listing.source_contract}
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
                                            <div className="flex flex-col items-end gap-1">
                                                <span>
                                                    {formatShortDate(
                                                        listing.type === "sold" ? listing.sold_at : listing.fetched_at
                                                    )}
                                                </span>
                                                <StalenessIndicator generatedAt={listing.fetched_at} />
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <RowActions listing={listing} onSelectListing={onSelectListing} />
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>

                        <div className="mt-4 flex flex-col gap-3 border-t border-white/5 pt-4 md:flex-row md:items-center md:justify-between">
                            <div className="font-mono text-[11px] text-gray-500">
                                {getListingRangeLabel({ page, limit, total })}
                            </div>
                            <Pagination className="mx-0 w-auto justify-start md:justify-end">
                                <PaginationContent>
                                    <PaginationItem>
                                        <Button
                                            variant="outline"
                                            className="border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                                            disabled={page <= 1}
                                            onClick={() => onPageChange(Math.max(page - 1, 1))}
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
                                            onClick={() => onPageChange(Math.min(page + 1, totalPages))}
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

function RowActions({
    listing,
    onSelectListing,
}: {
    listing: ListingRow;
    onSelectListing: (listingId: number) => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    className="size-8 border-white/10 bg-white/[0.02] text-gray-300 hover:bg-white/[0.04]"
                    onClick={(event) => {
                        event.stopPropagation();
                    }}
                >
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Listing actions</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => onSelectListing(listing.id)}>View details</DropdownMenuItem>
                    <DropdownMenuItem asChild>
                        <a href={listing.link} target="_blank" rel="noreferrer">
                            Open source
                        </a>
                    </DropdownMenuItem>
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function isNestedInteractiveTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return target.closest("a, button, input, select, textarea, summary, [role='button'], [role='menuitem']") !== null;
}
