import type { BezrealitkyAdvertDetail } from "@app/Internal/commands/reas/api/bezrealitky-client";
import { PROPERTY_TYPES } from "@app/Internal/commands/reas/lib/config-builder";
import type { ListingRow } from "@app/Internal/commands/reas/lib/store";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/components/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { toast } from "@ui/index";
import { cn } from "@ui/lib/utils";
import { ExternalLink, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { buildListingCompareQuery } from "../compare/compare-query";
import {
    extractFirstSeenAt,
    extractImageGallery,
    extractNemoreportLinks,
    extractPoiHighlights,
    getPriceChange,
    mergeImageGallery,
} from "./listing-detail-model";
import { SourceBadge } from "./SourceBadge";

interface ListingDetailResponse {
    listing: ListingRow;
    raw: unknown;
    hydratedDetail: BezrealitkyAdvertDetail | null;
    linkedProperty: {
        id: number;
        name: string;
    } | null;
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
    const queryClient = useQueryClient();
    const [constructionType, setConstructionType] = useState(PROPERTY_TYPES[1]?.value ?? PROPERTY_TYPES[0].value);

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
    const hydratedDetail = detailQuery.data?.hydratedDetail ?? null;
    const rawContent = formatRawJson(detailQuery.data?.raw);
    const originalPrice = getOriginalPrice({ raw: detailQuery.data?.raw, hydratedDetail });
    const availableFrom = getAvailableFrom({ raw: detailQuery.data?.raw, hydratedDetail });
    const firstSeenAt = extractFirstSeenAt(detailQuery.data?.raw);
    const priceChange = listing ? getPriceChange({ currentPrice: listing.price, originalPrice }) : null;
    const mapEmbedUrl = listing ? buildMapEmbedUrl(listing) : null;
    const mapLinkUrl = listing ? buildMapLinkUrl(listing) : null;
    const listingTimeline = listing
        ? buildListingTimeline({ listing, originalPrice, availableFrom, firstSeenAt, priceChange })
        : [];
    const compareHref = listing ? `/compare?${buildListingCompareQuery(listing).toString()}` : null;
    const providerLinks = hydratedDetail?.links ?? [];
    const regionTree = hydratedDetail?.regionTree ?? [];
    const relatedAdverts = hydratedDetail?.relatedAdverts ?? [];
    const linkedProperty = detailQuery.data?.linkedProperty ?? null;
    const poiHighlights = extractPoiHighlights(hydratedDetail?.poiData);
    const reportLinks = extractNemoreportLinks(hydratedDetail?.nemoreport);
    const imageGallery = mergeImageGallery({
        primary: extractImageGallery(detailQuery.data?.raw),
        secondary: hydratedDetail?.publicImages.map((image) => ({ full: image.url, preview: image.url })) ?? [],
    });
    const formattedAds = hydratedDetail?.formattedAds ?? [];

    useEffect(() => {
        if (!open) {
            return;
        }

        setConstructionType(PROPERTY_TYPES[1]?.value ?? PROPERTY_TYPES[0].value);
    }, [open]);

    const saveToWatchlistMutation = useMutation({
        mutationFn: async () => {
            if (listingId === null) {
                throw new Error("Listing id is missing");
            }

            const response = await fetch(`/api/listings/${listingId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify({ constructionType }),
            });
            const body = (await response.json()) as {
                error?: string;
                id?: number;
                name?: string | null;
                alreadyExists?: boolean;
            };

            if (!response.ok) {
                throw new Error(body.error ?? "Failed to add listing to watchlist");
            }

            if (!body.id) {
                throw new Error("Property id missing from watchlist response");
            }

            return {
                id: body.id,
                name: body.name ?? "Saved property",
                alreadyExists: body.alreadyExists === true,
            };
        },
        onSuccess: async (result) => {
            await queryClient.invalidateQueries({ queryKey: ["properties"] });
            await queryClient.invalidateQueries({ queryKey: ["listing-detail", listingId] });

            if (result.alreadyExists) {
                toast.success(`Already in watchlist as ${result.name}`);
                return;
            }

            toast.success(`Added to watchlist as ${result.name}`);
        },
        onError: (error: Error) => {
            toast.error(error.message);
        },
    });

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full border-white/10 bg-[#09090d] p-0 sm:max-w-2xl">
                <div className="flex h-full flex-col">
                    <SheetHeader className="border-b border-white/5 px-6 py-5 pr-14">
                        <div className="flex flex-wrap items-center gap-2">
                            {listing && (
                                <>
                                    <SourceBadge
                                        source={listing.source}
                                        href={listing.link}
                                        className="tracking-[0.2em]"
                                    />
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
                                    {linkedProperty && (
                                        <Button
                                            asChild
                                            size="sm"
                                            variant="outline"
                                            className="h-7 border-cyan-500/20 bg-cyan-500/5 px-2.5 text-[10px] font-mono uppercase tracking-[0.18em] text-cyan-300 hover:bg-cyan-500/10"
                                        >
                                            <Link
                                                to="/watchlist/$propertyId"
                                                params={{ propertyId: String(linkedProperty.id) }}
                                            >
                                                In watchlist
                                            </Link>
                                        </Button>
                                    )}
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

                                {linkedProperty && (
                                    <section className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.03] p-4">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                            <div>
                                                <div className="text-[11px] font-mono uppercase tracking-[0.24em] text-cyan-300">
                                                    Watchlist link
                                                </div>
                                                <p className="mt-1 font-mono text-sm text-gray-200">
                                                    {linkedProperty.name}
                                                </p>
                                                <p className="mt-1 font-mono text-xs text-gray-400">
                                                    This listing already has a saved property entry.
                                                </p>
                                            </div>
                                            <Button
                                                asChild
                                                size="sm"
                                                variant="outline"
                                                className="border-cyan-500/20 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/10"
                                            >
                                                <Link
                                                    to="/watchlist/$propertyId"
                                                    params={{ propertyId: String(linkedProperty.id) }}
                                                >
                                                    Open watchlist
                                                </Link>
                                            </Button>
                                        </div>
                                    </section>
                                )}

                                <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                                    <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                        Description
                                    </div>
                                    <p className="whitespace-pre-wrap text-sm leading-6 text-gray-300">
                                        {listing.description ?? "No description available."}
                                    </p>
                                </section>

                                {imageGallery.length > 0 && (
                                    <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                                        <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                            Media gallery
                                        </div>
                                        <div className="flex gap-3 overflow-x-auto pb-1">
                                            {imageGallery.map((image, index) => (
                                                <a
                                                    key={`${image.full}-${index}`}
                                                    href={image.full}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="group relative block shrink-0 overflow-hidden rounded-lg border border-white/10 bg-black/20"
                                                >
                                                    <img
                                                        src={image.preview}
                                                        alt={`Listing media ${index + 1}`}
                                                        loading="lazy"
                                                        className="h-28 w-40 object-cover transition duration-200 group-hover:scale-[1.02]"
                                                    />
                                                </a>
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {listingTimeline.length > 0 && (
                                    <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                                        <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                            Price timeline
                                        </div>
                                        <div className="grid gap-3 sm:grid-cols-2">
                                            {listingTimeline.map((entry) => (
                                                <Metric
                                                    key={`${entry.label}-${entry.value}`}
                                                    label={entry.label}
                                                    value={entry.value}
                                                    accent={entry.accent}
                                                />
                                            ))}
                                        </div>
                                    </section>
                                )}

                                {listing.coordinates_lat !== null &&
                                    listing.coordinates_lng !== null &&
                                    mapEmbedUrl &&
                                    mapLinkUrl && (
                                        <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                <div>
                                                    <div className="text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                                        Map
                                                    </div>
                                                    <p className="mt-1 font-mono text-xs text-gray-400">
                                                        {listing.coordinates_lat.toFixed(5)},{" "}
                                                        {listing.coordinates_lng.toFixed(5)}
                                                    </p>
                                                </div>
                                                <Button
                                                    asChild
                                                    size="sm"
                                                    variant="outline"
                                                    className="border-white/10 bg-black/20 text-gray-300 hover:bg-white/[0.04]"
                                                >
                                                    <a href={mapLinkUrl} target="_blank" rel="noreferrer">
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                        Open map
                                                    </a>
                                                </Button>
                                            </div>
                                            <iframe
                                                title={`Map for ${listing.address}`}
                                                src={mapEmbedUrl}
                                                className="h-64 w-full rounded-lg border border-white/5"
                                                loading="lazy"
                                            />
                                        </section>
                                    )}

                                {hydratedDetail && (
                                    <section className="rounded-xl border border-cyan-500/15 bg-cyan-500/[0.03] p-4">
                                        <div className="mb-3 text-[11px] font-mono uppercase tracking-[0.24em] text-cyan-300">
                                            Bezrealitky detail
                                        </div>
                                        <div className="grid gap-3 sm:grid-cols-2">
                                            <Metric
                                                label="Charges"
                                                value={formatCurrency(hydratedDetail.charges ?? null)}
                                            />
                                            <Metric
                                                label="Deposit"
                                                value={formatCurrency(hydratedDetail.deposit ?? null)}
                                            />
                                            <Metric
                                                label="Service charges"
                                                value={formatCurrency(hydratedDetail.serviceCharges ?? null)}
                                            />
                                            <Metric
                                                label="Utility charges"
                                                value={formatCurrency(hydratedDetail.utilityCharges ?? null)}
                                            />
                                            <Metric
                                                label="Available from"
                                                value={formatUnknownDate(hydratedDetail.availableFrom)}
                                            />
                                            <Metric
                                                label="Original price"
                                                value={formatCurrency(hydratedDetail.originalPrice ?? null)}
                                            />
                                        </div>

                                        {regionTree.length > 0 && (
                                            <div className="mt-4 flex flex-wrap items-center gap-2">
                                                {regionTree.map((region) => (
                                                    <Badge
                                                        key={`${region.id}-${region.name}`}
                                                        variant="outline"
                                                        className="border-white/10 bg-white/[0.03] font-mono text-[10px] text-gray-300"
                                                    >
                                                        {region.name}
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}

                                        {providerLinks.length > 0 && (
                                            <div className="mt-4 flex flex-wrap items-center gap-2">
                                                {providerLinks.map((link, index) => (
                                                    <Button
                                                        key={`${link.url}-${index}`}
                                                        asChild
                                                        size="sm"
                                                        variant="outline"
                                                        className="border-white/10 bg-black/20 text-gray-300 hover:bg-white/[0.04]"
                                                    >
                                                        <a href={link.url} target="_blank" rel="noreferrer">
                                                            <ExternalLink className="h-3.5 w-3.5" />
                                                            {link.type ?? `Link ${index + 1}`}
                                                        </a>
                                                    </Button>
                                                ))}
                                            </div>
                                        )}

                                        {poiHighlights.length > 0 && (
                                            <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-3">
                                                <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                                    Nearby signals
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                    {poiHighlights.map((highlight) => (
                                                        <Badge
                                                            key={`${highlight.category}-${highlight.name}`}
                                                            variant="outline"
                                                            className="border-white/10 bg-white/[0.03] font-mono text-[10px] text-gray-300"
                                                        >
                                                            {formatPoiCategory(highlight.category)}: {highlight.name}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {reportLinks.length > 0 && (
                                            <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-3">
                                                <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                                    Report links
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                    {reportLinks.map((link) => (
                                                        <Button
                                                            key={`${link.label}-${link.url}`}
                                                            asChild
                                                            size="sm"
                                                            variant="outline"
                                                            className="border-white/10 bg-black/20 text-gray-300 hover:bg-white/[0.04]"
                                                        >
                                                            <a href={link.url} target="_blank" rel="noreferrer">
                                                                <ExternalLink className="h-3.5 w-3.5" />
                                                                {link.label}
                                                            </a>
                                                        </Button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {formattedAds.length > 0 && (
                                            <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-3">
                                                <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                                    Formatted ads
                                                </div>
                                                <div className="flex flex-col gap-2">
                                                    {formattedAds.map((entry, index) => (
                                                        <div
                                                            key={`${entry.title ?? entry.value ?? index}`}
                                                            className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs font-mono text-gray-300"
                                                        >
                                                            <span className="text-gray-400">
                                                                {entry.title ?? `Detail ${index + 1}`}
                                                            </span>
                                                            {entry.valueHref ? (
                                                                <a
                                                                    href={entry.valueHref}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="flex items-center gap-2 text-cyan-300 hover:text-cyan-200"
                                                                >
                                                                    <span className="text-right">
                                                                        {entry.value ?? entry.valueHref}
                                                                    </span>
                                                                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                                                                </a>
                                                            ) : (
                                                                <span className="text-right">
                                                                    {entry.value ?? "--"}
                                                                </span>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {relatedAdverts.length > 0 && (
                                            <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-3">
                                                <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.24em] text-gray-500">
                                                    Related adverts
                                                </div>
                                                <div className="flex flex-col gap-2">
                                                    {relatedAdverts.slice(0, 4).map((advert) => (
                                                        <a
                                                            key={`${advert.source}-${advert.sourceId}`}
                                                            href={advert.link}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs font-mono text-gray-300 hover:border-cyan-500/30 hover:text-cyan-300"
                                                        >
                                                            <span className="truncate">
                                                                {getRelatedAdvertLabel(advert)}
                                                            </span>
                                                            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                                                        </a>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </section>
                                )}

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
                                        <div className="flex flex-wrap items-center justify-end gap-2">
                                            <Select value={constructionType} onValueChange={setConstructionType}>
                                                <SelectTrigger className="h-9 w-[120px] border-white/10 bg-black/20 font-mono text-xs text-gray-200">
                                                    <SelectValue placeholder="Type" />
                                                </SelectTrigger>
                                                <SelectContent className="border-white/10 bg-[#09090d] font-mono text-xs text-gray-200">
                                                    {PROPERTY_TYPES.map((type) => (
                                                        <SelectItem
                                                            key={type.value}
                                                            value={type.value}
                                                            className="font-mono text-xs text-gray-200"
                                                        >
                                                            {type.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button
                                                asChild
                                                size="sm"
                                                variant="outline"
                                                className="border-white/10 bg-black/20 text-gray-300 hover:bg-white/[0.04]"
                                            >
                                                <Link to={compareHref ?? "/compare"} disabled={!compareHref}>
                                                    Compare district
                                                </Link>
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => {
                                                    saveToWatchlistMutation.mutate();
                                                }}
                                                disabled={saveToWatchlistMutation.isPending || linkedProperty !== null}
                                                className="border-amber-500/20 bg-amber-500/5 text-amber-300 hover:bg-amber-500/10"
                                            >
                                                {linkedProperty
                                                    ? "Saved to watchlist"
                                                    : saveToWatchlistMutation.isPending
                                                      ? "Saving..."
                                                      : "Add to watchlist"}
                                            </Button>
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

function buildListingTimeline({
    listing,
    originalPrice,
    availableFrom,
    firstSeenAt,
    priceChange,
}: {
    listing: ListingRow;
    originalPrice: number | null;
    availableFrom: string | number | null;
    firstSeenAt: string | null;
    priceChange: { amount: number; percent: number } | null;
}) {
    const timeline: Array<{ label: string; value: string; accent?: boolean }> = [
        {
            label: "Current ask",
            value: formatCurrency(listing.price),
            accent: true,
        },
        {
            label: "Fetched",
            value: formatDateTime(listing.fetched_at),
        },
    ];

    if (firstSeenAt) {
        timeline.push({
            label: "First seen",
            value: formatDateTime(firstSeenAt),
        });
    }

    if (originalPrice !== null) {
        timeline.push({
            label: "Original ask",
            value: formatCurrency(originalPrice),
        });
    }

    if (priceChange) {
        timeline.push({
            label: "Price change",
            value: `${formatSignedCurrency(priceChange.amount)} (${formatSignedPercent(priceChange.percent)})`,
            accent: priceChange.amount < 0,
        });
    }

    if (listing.sold_at) {
        timeline.push({
            label: "Sold",
            value: formatDateTime(listing.sold_at),
        });
    }

    if (availableFrom !== null && availableFrom !== undefined) {
        timeline.push({
            label: "Available from",
            value: formatUnknownDate(availableFrom),
        });
    }

    if (listing.days_on_market !== null) {
        timeline.push({
            label: "Days on market",
            value: formatNumberUnit(listing.days_on_market, "days"),
        });
    }

    return timeline;
}

function buildMapEmbedUrl(listing: ListingRow) {
    if (listing.coordinates_lat === null || listing.coordinates_lng === null) {
        return null;
    }

    const lat = listing.coordinates_lat;
    const lng = listing.coordinates_lng;
    const delta = 0.008;
    const bbox = [lng - delta, lat - delta, lng + delta, lat + delta].join(",");

    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lng}`)}`;
}

function buildMapLinkUrl(listing: ListingRow) {
    if (listing.coordinates_lat === null || listing.coordinates_lng === null) {
        return null;
    }

    return `https://www.openstreetmap.org/?mlat=${listing.coordinates_lat}&mlon=${listing.coordinates_lng}#map=16/${listing.coordinates_lat}/${listing.coordinates_lng}`;
}

function getOriginalPrice({ raw, hydratedDetail }: { raw: unknown; hydratedDetail: BezrealitkyAdvertDetail | null }) {
    if (hydratedDetail?.originalPrice !== undefined) {
        return hydratedDetail.originalPrice;
    }

    if (!isRecord(raw)) {
        return null;
    }

    return typeof raw.originalPrice === "number" ? raw.originalPrice : null;
}

function getAvailableFrom({ raw, hydratedDetail }: { raw: unknown; hydratedDetail: BezrealitkyAdvertDetail | null }) {
    if (hydratedDetail?.availableFrom !== undefined) {
        return hydratedDetail.availableFrom;
    }

    if (!isRecord(raw)) {
        return null;
    }

    const value = raw.availableFrom;

    if (typeof value === "string" || typeof value === "number") {
        return value;
    }

    return null;
}

function getRelatedAdvertLabel(advert: { address?: string; locality?: string; price: number; link?: string }) {
    return `${advert.address ?? advert.locality ?? advert.link ?? "Listing"} • ${formatCurrency(advert.price)}`;
}

function formatUnknownDate(value: string | number | null | undefined) {
    if (value === null || value === undefined || value === "") {
        return "--";
    }

    if (typeof value === "number") {
        return formatDateTime(new Date(value * 1000).toISOString());
    }

    return formatDateTime(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
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

function formatSignedCurrency(value: number) {
    const prefix = value > 0 ? "+" : "";

    return `${prefix}${value.toLocaleString("cs-CZ")} CZK`;
}

function formatSignedPercent(value: number) {
    const prefix = value > 0 ? "+" : "";

    return `${prefix}${value.toFixed(1)}%`;
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

function formatPoiCategory(value: string) {
    return value.replaceAll("_", " ");
}
