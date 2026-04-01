import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib/utils";
import { Clock } from "lucide-react";
import { useMemo } from "react";

interface StalenessIndicatorProps {
    generatedAt: string;
}

type Freshness = "fresh" | "recent" | "stale";

interface StalenessInfo {
    freshness: Freshness;
    label: string;
    ageMs: number;
}

function computeStaleness(generatedAt: string): StalenessInfo {
    const generated = new Date(generatedAt).getTime();
    const now = Date.now();
    const ageMs = now - generated;

    const seconds = Math.floor(ageMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    let label: string;

    if (seconds < 60) {
        label = "just now";
    } else if (minutes < 60) {
        label = `${minutes}m ago`;
    } else if (hours < 24) {
        label = `${hours}h ago`;
    } else {
        label = `${days}d ago`;
    }

    let freshness: Freshness;

    if (ageMs < 60 * 60 * 1000) {
        freshness = "fresh";
    } else if (ageMs < 24 * 60 * 60 * 1000) {
        freshness = "recent";
    } else {
        freshness = "stale";
    }

    return { freshness, label, ageMs };
}

const FRESHNESS_COLORS: Record<Freshness, string> = {
    fresh: "bg-green-500/15 border-green-500/30 text-green-400",
    recent: "bg-amber-500/15 border-amber-500/30 text-amber-400",
    stale: "bg-red-500/15 border-red-500/30 text-red-400",
};

export function StalenessIndicator({ generatedAt }: StalenessIndicatorProps) {
    const { freshness, label } = useMemo(() => computeStaleness(generatedAt), [generatedAt]);

    return (
        <Badge className={cn("font-mono text-[10px] gap-1", FRESHNESS_COLORS[freshness])}>
            <Clock className="h-3 w-3" />
            {label}
        </Badge>
    );
}
