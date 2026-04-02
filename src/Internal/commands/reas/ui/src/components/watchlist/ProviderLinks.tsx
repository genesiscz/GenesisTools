import { buildProviderBrowseLinks } from "@app/Internal/commands/reas/lib/url-builder";
import type { ProviderName } from "@app/Internal/commands/reas/types";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib/utils";
import { ExternalLink } from "lucide-react";
import { PROVIDER_BADGE_STYLES, PROVIDER_LABELS } from "./watchlist-utils";

interface ProviderLinksProps {
    district: string;
    listingUrl?: string | null;
    providers: ProviderName[];
}

export function ProviderLinks({ district, listingUrl, providers }: ProviderLinksProps) {
    const links = buildProviderBrowseLinks({ district, listingUrl, providers });

    if (links.length === 0) {
        return null;
    }

    return (
        <div className="rounded-md border border-white/5 bg-black/20 p-3">
            <div className="mb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-gray-500">Provider links</div>
            <div className="flex flex-col gap-2">
                {links.map((link) => (
                    <div
                        key={`${link.provider}-${link.kind}`}
                        className="flex flex-col gap-2 rounded-md border border-white/5 bg-white/[0.02] p-2 md:flex-row md:items-center md:justify-between"
                    >
                        <div className="flex items-center gap-2">
                            <Badge
                                variant="outline"
                                className={cn(
                                    "border-white/10 bg-white/[0.02] text-[10px] font-mono",
                                    PROVIDER_BADGE_STYLES[link.provider] ?? "text-gray-400"
                                )}
                            >
                                {PROVIDER_LABELS[link.provider] ?? link.provider}
                            </Badge>
                            <span className="text-[11px] font-mono text-gray-400">
                                {link.kind === "listing" ? "Stored listing" : "Browse search"}
                            </span>
                        </div>
                        <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="border-cyan-500/20 bg-cyan-500/5 text-cyan-300 hover:bg-cyan-500/10"
                        >
                            <a href={link.url} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-3.5 w-3.5" />
                                {link.label}
                            </a>
                        </Button>
                    </div>
                ))}
            </div>
        </div>
    );
}
