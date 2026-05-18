import type { CoverageRow } from "@app/shops/types";
import { ShopBadge } from "@app/shops/ui/components/ShopBadge";
import { Badge } from "@app/utils/ui/components/badge";
import { Card, CardContent } from "@app/utils/ui/components/card";

interface CoverageShopCardProps {
    row: CoverageRow;
}

const CAPABILITY_FIELDS: Array<{ key: keyof CoverageRow; label: string }> = [
    { key: "cap_live", label: "live" },
    { key: "cap_history", label: "history" },
    { key: "cap_listing", label: "listing" },
    { key: "cap_ean", label: "ean" },
    { key: "cap_search", label: "search" },
];

function statusColor(status: string): string {
    switch (status) {
        case "completed":
            return "bg-emerald-400";
        case "running":
        case "matching":
            return "bg-cyan-400 animate-pulse";
        case "failed":
            return "bg-rose-400";
        case "cancelled":
            return "bg-zinc-500"; // allow-palette: categorical "cancelled" status dot (parallels cyan/rose/amber)
        default:
            return "bg-amber-400";
    }
}

function botProtectionBadge(p: CoverageRow["bot_protection"]) {
    switch (p) {
        case "none":
            return null;
        case "soft":
            return { label: "SOFT", className: "border-amber-400/40 text-amber-300" };
        case "akamai":
            return { label: "AKAMAI", className: "border-rose-400/40 text-rose-300" };
        case "cloudflare":
            return { label: "CLOUDFLARE", className: "border-rose-400/40 text-rose-300" };
    }
}

export function CoverageShopCard({ row }: CoverageShopCardProps) {
    const bot = botProtectionBadge(row.bot_protection);

    return (
        <Card className="hover:border-cyan-400/30 transition-colors">
            <CardContent className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                    <ShopBadge origin={row.shop_origin} label={row.display_name} />
                    {bot && (
                        <Badge
                            variant="outline"
                            className={`font-mono text-[9px] tracking-[0.15em] uppercase ${bot.className}`}
                        >
                            {bot.label}
                        </Badge>
                    )}
                </div>

                <div className="font-mono text-2xl text-foreground">{row.product_count.toLocaleString()}</div>
                <div className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground uppercase">products</div>

                <div className="flex flex-wrap gap-1">
                    {CAPABILITY_FIELDS.map(({ key, label }) =>
                        row[key] === 1 ? (
                            <Badge
                                key={key as string}
                                variant="outline"
                                className="font-mono text-[9px] tracking-[0.15em] uppercase border-emerald-400/30 text-emerald-300/80 px-1.5 py-0.5"
                            >
                                {label}
                            </Badge>
                        ) : null
                    )}
                </div>

                <div className="flex items-center gap-1 pt-1">
                    {row.recent_runs.length === 0 ? (
                        <span className="font-mono text-[9px] tracking-[0.15em] text-muted-foreground uppercase">
                            no crawls
                        </span>
                    ) : (
                        <>
                            <span className="font-mono text-[9px] tracking-[0.15em] text-muted-foreground uppercase mr-1">
                                runs:
                            </span>
                            {row.recent_runs.map((r) => (
                                <span
                                    key={r.id}
                                    title={`${r.status} · ${r.products_seen} seen / ${r.products_new} new`}
                                    className={`block w-2 h-2 rounded-sm ${statusColor(r.status)}`}
                                />
                            ))}
                        </>
                    )}
                </div>

                {row.last_crawl_at && (
                    <div className="font-mono text-[9px] tracking-[0.1em] text-muted-foreground">
                        last: {row.last_crawl_at.slice(0, 16).replace("T", " ")}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
