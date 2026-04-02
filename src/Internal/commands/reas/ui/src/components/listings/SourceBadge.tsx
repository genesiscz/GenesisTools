import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";

const SOURCE_STYLES: Record<string, string> = {
    sreality: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    bezrealitky: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    ereality: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    "mf-rental": "border-amber-500/30 bg-amber-500/10 text-amber-300",
    mf: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    reas: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

interface SourceBadgeProps {
    source: string;
    className?: string;
}

export function SourceBadge({ source, className }: SourceBadgeProps) {
    return (
        <Badge
            variant="outline"
            className={cn(
                "text-[10px] font-mono uppercase tracking-[0.16em]",
                SOURCE_STYLES[source] ?? "border-white/10 bg-white/[0.03] text-gray-300",
                className
            )}
        >
            {source}
        </Badge>
    );
}
