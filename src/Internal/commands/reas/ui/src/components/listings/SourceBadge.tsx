import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import { ExternalLink } from "lucide-react";

const SOURCE_META: Record<string, { label: string; className: string }> = {
    sreality: {
        label: "Sreality",
        className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    },
    bezrealitky: {
        label: "Bezrealitky",
        className: "border-orange-500/30 bg-orange-500/10 text-orange-300",
    },
    ereality: {
        label: "eReality",
        className: "border-purple-500/30 bg-purple-500/10 text-purple-300",
    },
    "mf-rental": {
        label: "MF Rental",
        className: "border-slate-500/30 bg-slate-500/10 text-slate-300",
    },
    mf: {
        label: "MF",
        className: "border-slate-500/30 bg-slate-500/10 text-slate-300",
    },
    reas: {
        label: "REAS",
        className: "border-blue-500/30 bg-blue-500/10 text-blue-300",
    },
};

interface SourceBadgeProps {
    source: string;
    className?: string;
    href?: string;
}

export function SourceBadge({ source, className, href }: SourceBadgeProps) {
    const metadata = SOURCE_META[source];
    const label = metadata?.label ?? source;

    const badge = (
        <Badge
            variant="outline"
            className={cn(
                "gap-1 text-[10px] font-mono uppercase tracking-[0.16em]",
                metadata?.className ?? "border-white/10 bg-white/[0.03] text-gray-300",
                className
            )}
        >
            <span>{label}</span>
            {href && <ExternalLink className="h-3 w-3" />}
        </Badge>
    );

    if (!href) {
        return badge;
    }

    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex transition-opacity hover:opacity-90"
            onClick={(event) => {
                event.stopPropagation();
            }}
        >
            {badge}
        </a>
    );
}
