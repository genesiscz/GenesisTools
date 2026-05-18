import type { MasterOfferRow } from "@app/shops/types";
import { ShopBadge } from "@app/shops/ui/components/ShopBadge";
import { SafeJSON } from "@app/utils/json";
import { Badge } from "@app/utils/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@app/utils/ui/components/tabs";
import { ChevronDown, ExternalLink, ImageOff } from "lucide-react";
import { useMemo, useState } from "react";

interface OfferDetailTabsProps {
    offers: MasterOfferRow[];
}

export function OfferDetailTabs({ offers }: OfferDetailTabsProps) {
    if (offers.length === 0) {
        return null;
    }

    const cheapestId = useMemo(() => {
        let id = String(offers[0].product_id);
        let min = Number.POSITIVE_INFINITY;
        for (const o of offers) {
            if (o.current_price !== null && o.current_price < min) {
                min = o.current_price;
                id = String(o.product_id);
            }
        }

        return id;
    }, [offers]);

    return (
        <Tabs defaultValue={cheapestId} className="gap-3">
            <TabsList className="!justify-start">
                {offers.map((o) => (
                    <TabsTrigger key={o.product_id} value={String(o.product_id)} className="gap-2 font-mono text-xs">
                        <ShopBadge origin={o.shop_origin} label={o.shop_display_name} />
                        <span className="text-[var(--color-neon-cyan)]">
                            {o.current_price !== null ? `${o.current_price.toFixed(2)} Kč` : "—"}
                        </span>
                    </TabsTrigger>
                ))}
            </TabsList>
            {offers.map((o) => (
                <TabsContent key={o.product_id} value={String(o.product_id)}>
                    <OfferDetailPanel offer={o} />
                </TabsContent>
            ))}
        </Tabs>
    );
}

function OfferDetailPanel({ offer }: { offer: MasterOfferRow }) {
    const breadcrumb = offer.category_path?.split(/\s*>\s*/).filter(Boolean) ?? [];
    const observed = offer.price_observed_at ? new Date(offer.price_observed_at) : null;
    const firstSeen = offer.first_seen_at ? new Date(offer.first_seen_at) : null;

    const meta = useMemo(() => {
        if (!offer.metadata_json) {
            return null;
        }

        try {
            const parsed = SafeJSON.parse(offer.metadata_json);
            return parsed && typeof parsed === "object" && Object.keys(parsed as object).length > 0
                ? (parsed as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    }, [offer.metadata_json]);

    return (
        <div className="border border-border rounded-md bg-card/60 overflow-hidden">
            <div className="flex flex-col md:flex-row gap-4 p-4">
                <div className="w-40 h-40 bg-muted border border-border rounded overflow-hidden flex items-center justify-center shrink-0">
                    {offer.image_url ? (
                        <img src={offer.image_url} alt={offer.name} className="w-full h-full object-contain" />
                    ) : (
                        <ImageOff className="w-10 h-10 text-muted-foreground" />
                    )}
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                            {breadcrumb.length > 0 ? (
                                <div
                                    className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground uppercase mb-1 truncate"
                                    title={breadcrumb.join(" > ")}
                                >
                                    {breadcrumb.join(" › ")}
                                </div>
                            ) : null}
                            <div className="font-mono text-base text-foreground leading-tight">{offer.name}</div>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                                <ShopBadge origin={offer.shop_origin} label={offer.shop_display_name} />
                                {offer.brand ? (
                                    <span className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground uppercase">
                                        {offer.brand}
                                    </span>
                                ) : null}
                                {offer.in_stock === 1 ? (
                                    <Badge
                                        variant="outline"
                                        className="font-mono text-[10px] border-emerald-400/40 text-emerald-300"
                                    >
                                        IN STOCK
                                    </Badge>
                                ) : offer.in_stock === 0 ? (
                                    <Badge
                                        variant="outline"
                                        className="font-mono text-[10px] border-rose-400/40 text-rose-300"
                                    >
                                        OUT
                                    </Badge>
                                ) : null}
                            </div>
                        </div>
                        <a
                            href={offer.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 font-mono text-xs px-3 py-1.5 rounded border border-cyan-400/40 text-[var(--color-neon-cyan)] hover:bg-cyan-400/10 transition-colors no-underline"
                        >
                            <ExternalLink className="w-3.5 h-3.5" />
                            OPEN @ {offer.shop_display_name.toUpperCase()}
                        </a>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-3 pt-1">
                        <span className="font-mono text-2xl text-[var(--color-neon-cyan)]">
                            {offer.current_price !== null ? `${offer.current_price.toFixed(2)} Kč` : "—"}
                        </span>
                        {offer.original_price !== null && offer.original_price !== offer.current_price ? (
                            <span className="font-mono text-sm text-muted-foreground line-through">
                                {offer.original_price.toFixed(2)} Kč
                            </span>
                        ) : null}
                        {offer.claimed_discount_percent !== null ? (
                            <Badge
                                variant="outline"
                                className="font-mono text-[10px] border-amber-400/40 text-amber-300"
                            >
                                -{offer.claimed_discount_percent.toFixed(0)}%
                            </Badge>
                        ) : null}
                    </div>
                </div>
            </div>

            {offer.description ? (
                <div className="border-t border-border/80 px-4 py-3">
                    <div className="font-mono text-[10px] tracking-[0.25em] text-muted-foreground uppercase mb-1.5">
                        Description
                    </div>
                    <p className="font-mono text-xs text-foreground leading-relaxed whitespace-pre-line">
                        {offer.description}
                    </p>
                </div>
            ) : null}

            <div className="border-t border-border/80 px-4 py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2 font-mono text-[11px]">
                <Spec label="EAN" value={offer.ean} />
                <Spec
                    label="Unit"
                    value={
                        offer.unit_amount !== null && offer.unit
                            ? `${offer.unit_amount} ${offer.unit}`
                            : (offer.unit ?? null)
                    }
                />
                <Spec label="Pack" value={offer.pack_count !== null ? `${offer.pack_count} ks` : null} />
                <Spec label="Shop slug" value={offer.shop_origin} />
                <Spec label="First seen" value={firstSeen ? firstSeen.toLocaleDateString("cs-CZ") : null} />
                <Spec
                    label="Price seen"
                    value={
                        observed
                            ? `${observed.toLocaleDateString("cs-CZ")} ${observed.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`
                            : null
                    }
                />
            </div>

            {meta ? <RawPayload meta={meta} /> : null}
        </div>
    );
}

function Spec({ label, value }: { label: string; value: string | null }) {
    return (
        <div className="min-w-0">
            <div className="text-[9px] tracking-[0.2em] text-muted-foreground uppercase">{label}</div>
            <div className="text-foreground truncate" title={value ?? undefined}>
                {value ?? <span className="text-muted-foreground">—</span>}
            </div>
        </div>
    );
}

function RawPayload({ meta }: { meta: Record<string, unknown> }) {
    const [open, setOpen] = useState(false);
    const json = useMemo(() => SafeJSON.stringify(meta, null, 2), [meta]);

    return (
        <div className="border-t border-border/80">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="w-full px-4 py-2 flex items-center gap-2 font-mono text-[10px] tracking-[0.25em] text-muted-foreground uppercase hover:bg-primary/5 transition-colors cursor-pointer"
            >
                <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-0" : "-rotate-90"}`} />
                Raw shop payload {open ? "" : `· ${Object.keys(meta).length} keys`}
            </button>
            {open ? (
                <pre className="px-4 pb-3 font-mono text-[10px] text-muted-foreground max-h-96 overflow-auto whitespace-pre-wrap break-all">
                    {json}
                </pre>
            ) : null}
        </div>
    );
}
