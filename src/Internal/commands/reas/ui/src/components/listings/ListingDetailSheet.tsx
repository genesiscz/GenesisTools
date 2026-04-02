import type { ListingRow } from "@app/Internal/commands/reas/lib/store";
import { SafeJSON } from "@app/utils/json";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib/utils";
import { ExternalLink, MapPin } from "lucide-react";
import { SourceBadge } from "./SourceBadge";

interface ListingDetailResponse {
    listing: ListingRow;
    raw: unknown;
}

interface ListingDetailSheetProps {
    listingId: number | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const DETAIL_SKELETON_KEYS = ["one", "two", "three", "four", "five", "six"] as const;

const STATUS_STYLES: Record<string, string> = {
    active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    sold: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    removed: "border-red-500/30 bg-red-500/10 text-red-300",
};

export function ListingDetailSheet({ listingId, open, onOpenChange }: ListingDetailSheetProps) {
    const detailQuery = useQuery<ListingDetailResponse>({
        queryKey: ["listing-detail", listingId],
        queryFn: async () => {
            const response = await fetch(`/api/listings/${listingId}`);

            if (!response.ok) {
                const body = (await response.json()) as { error?: string };
                throw new Error(body.error ?? `Failed to fetch listing (${response.status})`);
            }

            return response.json() as Promise<ListingDetailResponse>;
        },
        enabled: open && listingId !== null,
    });

    const listing = detailQuery.data?.listing;
    const rawContent = formatRawJson(detailQuery.data?.raw);

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full border-white/10 bg-[#09090d] p-0 sm:max-w-2xl">
                <div className="flex h-full flex-col">
                    <SheetHeader className="border-b border-white/5 px-6 py-5 pr-14">
                        <div className="flex flex-wrap items-center gap-2">
                            {listing && (
                                <>
                                    <SourceBadge source={listing.source} className="tracking-[0.2em]" />
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "text-[10px] font-mono uppercase tracking-[0.2em]",
                                            getStatusStyle(listing.status)
                                        )}
                                    >
                                        {listing.status}
                                    </Badge>
                                    <Badge
                                        variant="outline"
                                        className="border-white/10 bg-white/[0.03] text-[10px] font-mono uppercase tracking-[0.2em] text-gray-300"
                                    >
                                        {listing.type}
                                    </Badge>
                                </>
                            )}
                        </div>
                        <SheetTitle className="font-mono text-xl text-gray-100">
                            {listing?.address ?? "Listing detail"}
                        </SheetTitle>
                        <SheetDescription className="flex items-center gap-2 font-mono text-xs text-gray-400">
                            <MapPin className="h-3.5 w-3.5" />
                            {listing
                                ? `${listing.district}${listing.disposition ? ` • ${listing.disposition}` : ""}`
                                : "Loading listing metadata"}
                        </SheetDescription>
                    </SheetHeader>

                    <ScrollArea className="h-[calc(100vh-132px)] px-6 py-5">
                        {detailQuery.isLoading && <DetailSkeleton />}

                        {detailQuery.isError && (
                            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 font-mono text-sm text-red-300">
                                {detailQuery.error.message}
                            </div>
                        )}

                        {listing && (
                            <div className="space-y-6 pb-6">
                                <section className="grid gap-3 sm:grid-cols-2">
                                    <Metric label="Price" value={formatCurrency(listing.price)} accent />
                                    <Metric label="Price / m2" value={formatNumberUnit(listing.price_per_m2, "CZK")} />
                                    <Metric label="Area" value={formatNumberUnit(listing.area, "m2")} />
                                    <Metric label="Building" value={listing.building_type ?? "--"} />
                                    <Metric label="Fetched" value={formatDateTime(listing.fetched_at)} />
                                    <Metric label="Sold" value={formatDateTime(listing.sold_at)} />
                                    <Metric
                                        label="Days on market"
                                        value={formatNumberUnit(listing.days_on_market, "days")}
                                    />
                                    <Metric label="Discount" value={formatPercent(listing.discount)} />
                                    <Metric label="Source contract" value={listing.source_contract} />
                                    <Metric label="Source id" value={listing.source_id} />
                                </section>

                                <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                                    <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                        Description
                                    </div>
                                    <p className="whitespace-pre-wrap text-sm leading-6 text-gray-300">
                                        {listing.description ?? "No description available."}
                                    </p>
                                </section>

                                <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div>
                                            <div className="text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                                Source link
                                            </div>
                                            <p className="mt-1 break-all font-mono text-xs text-gray-400">
                                                {listing.link}
                                            </p>
                                        </div>
                                        <Button
                                            asChild
                                            size="sm"
                                            variant="outline"
                                            className="border-cyan-500/20 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/10"
                                        >
                                            <a href={listing.link} target="_blank" rel="noreferrer">
                                                <ExternalLink className="h-3.5 w-3.5" />
                                                Open source
                                            </a>
                                        </Button>
                                    </div>
                                </section>

                                <section className="rounded-xl border border-white/5 bg-black/30 p-4">
                                    <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                        Raw payload
                                    </div>
                                    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-white/5 bg-black/30 p-4 font-mono text-[11px] leading-5 text-gray-300">
                                        {rawContent}
                                    </pre>
                                </section>
                            </div>
                        )}
                    </ScrollArea>
                </div>
            </SheetContent>
        </Sheet>
    );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
    return (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <div className="text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">{label}</div>
            <div className={cn("mt-2 font-mono text-sm text-gray-200", accent && "text-amber-300")}>{value}</div>
        </div>
    );
}

function DetailSkeleton() {
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
                {DETAIL_SKELETON_KEYS.map((key) => (
                    <Skeleton key={key} variant="card" className="h-24" />
                ))}
            </div>
            <Skeleton variant="card" className="h-32" />
            <Skeleton variant="card" className="h-64" />
        </div>
    );
}

function getStatusStyle(status: string) {
    return STATUS_STYLES[status] ?? "border-white/10 bg-white/[0.03] text-gray-300";
}

function formatCurrency(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} CZK`;
}

function formatNumberUnit(value: number | null, unit: string) {
    if (value === null) {
        return "--";
    }

    return `${value.toLocaleString("cs-CZ")} ${unit}`;
}

function formatPercent(value: number | null) {
    if (value === null) {
        return "--";
    }

    return `${value.toFixed(1)}%`;
}

function formatDateTime(value: string | null) {
    if (!value) {
        return "--";
    }

    const date = new Date(value);

    return new Intl.DateTimeFormat("cs-CZ", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function formatRawJson(value: unknown) {
    if (value === undefined) {
        return "No raw payload available.";
    }

    try {
        return SafeJSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}
