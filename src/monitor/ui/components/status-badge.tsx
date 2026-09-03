import type { WatcherStatus } from "@app/monitor/lib/types";
import { STATUS_LABEL } from "@app/monitor/ui/lib/format";
import { Badge } from "@genesiscz/utils/ui/components/badge";
import { cn } from "@genesiscz/utils/ui/lib/utils";
import { CheckCircle2, CircleHelp, OctagonAlert, PauseCircle, TriangleAlert } from "lucide-react";

// allow-palette: categorical status colors (up/degraded/down) are semantic, not theme surfaces
const TONE: Record<WatcherStatus | "paused", { className: string; icon: typeof CheckCircle2; dot: string }> = {
    up: {
        className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
        icon: CheckCircle2,
        dot: "bg-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.85)]",
    },
    degraded: {
        className: "border-amber-400/40 bg-amber-400/10 text-amber-200",
        icon: TriangleAlert,
        dot: "bg-amber-400 shadow-[0_0_14px_rgba(245,158,11,0.85)]",
    },
    down: {
        className: "border-red-400/40 bg-red-500/10 text-red-200 shadow-[0_0_18px_rgba(239,68,68,0.25)]",
        icon: OctagonAlert,
        dot: "bg-red-500 shadow-[0_0_14px_rgba(239,68,68,0.9)] mon-pulse",
    },
    unknown: {
        className: "border-muted-foreground/25 bg-muted/40 text-muted-foreground",
        icon: CircleHelp,
        dot: "bg-muted-foreground/60",
    },
    paused: {
        className: "border-muted-foreground/25 bg-muted/30 text-muted-foreground",
        icon: PauseCircle,
        dot: "bg-muted-foreground/40",
    },
};

export function statusKey(status: WatcherStatus, enabled: boolean): WatcherStatus | "paused" {
    return enabled ? status : "paused";
}

export function StatusBadge({
    status,
    enabled = true,
    className,
}: {
    status: WatcherStatus;
    enabled?: boolean;
    className?: string;
}) {
    const key = statusKey(status, enabled);
    const tone = TONE[key];
    const Icon = tone.icon;

    return (
        <Badge
            variant="outline"
            className={cn("gap-1.5 font-mono text-[0.65rem] uppercase tracking-[0.18em]", tone.className, className)}
        >
            <Icon className="size-3" />
            {key === "paused" ? "Paused" : STATUS_LABEL[status]}
        </Badge>
    );
}

export function StatusDot({
    status,
    enabled = true,
    className,
}: {
    status: WatcherStatus;
    enabled?: boolean;
    className?: string;
}) {
    return (
        <span className={cn("inline-block size-2.5 rounded-full", TONE[statusKey(status, enabled)].dot, className)} />
    );
}
