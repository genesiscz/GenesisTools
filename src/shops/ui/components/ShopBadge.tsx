import { Badge } from "@app/utils/ui/components/badge";
import { cn } from "@app/utils/ui/lib/utils";
import type { ShopOrigin } from "@app/shops/api/ShopApiClient.types";

const PALETTE = [
    "border-cyan-400/40 text-cyan-300",
    "border-amber-400/40 text-amber-300",
    "border-emerald-400/40 text-emerald-300",
    "border-violet-400/40 text-violet-300",
    "border-rose-400/40 text-rose-300",
    "border-sky-400/40 text-sky-300",
    "border-yellow-400/40 text-yellow-300",
    "border-fuchsia-400/40 text-fuchsia-300",
] as const;

export function shopColorClass(origin: ShopOrigin | null | undefined): string {
    if (!origin) {
        return PALETTE[0];
    }

    let hash = 0;
    for (let i = 0; i < origin.length; i++) {
        hash = (hash * 31 + origin.charCodeAt(i)) | 0;
    }

    return PALETTE[Math.abs(hash) % PALETTE.length];
}

interface ShopBadgeProps {
    origin: ShopOrigin | null | undefined;
    label?: string;
    className?: string;
}

export function ShopBadge({ origin, label, className }: ShopBadgeProps) {
    if (!origin) {
        return null;
    }

    return (
        <Badge
            variant="outline"
            className={cn(
                "font-mono text-[10px] tracking-[0.15em] uppercase px-1.5 py-0.5",
                shopColorClass(origin),
                className,
            )}
        >
            {label ?? origin.replace(/\.cz$/, "")}
        </Badge>
    );
}
