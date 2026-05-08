import type { LiveEvent } from "@app/shops/types";
import { Badge } from "@app/utils/ui/components/badge";
import { ShopBadge } from "./ShopBadge";

interface LiveEventRowProps {
    frame: LiveEvent;
}

function statusColor(status: number | null): string {
    if (status === null) {
        return "text-muted-foreground";
    }

    if (status >= 500) {
        return "text-rose-400";
    }

    if (status >= 400) {
        return "text-amber-400";
    }

    if (status >= 300) {
        return "text-violet-400";
    }

    return "text-emerald-400";
}

function durationColor(ms: number): string {
    if (ms > 5000) {
        return "text-rose-400";
    }

    if (ms > 1500) {
        return "text-amber-400";
    }

    return "text-emerald-400";
}

export function LiveEventRow({ frame }: LiveEventRowProps) {
    const ts = "ts" in frame ? frame.ts : "";
    const time = ts ? ts.slice(11, 23) : "";

    if (frame.event === "http-request") {
        return (
            <div className="grid grid-cols-[80px_60px_70px_60px_1fr_120px] gap-2 py-1 px-3 font-mono text-[11px] hover:bg-white/5 transition-colors border-b border-zinc-900/50">
                <span className="text-muted-foreground">{time}</span>
                <ShopBadge origin={frame.shop_origin} />
                <span className={statusColor(frame.status)}>{frame.status ?? "—"}</span>
                <span className={durationColor(frame.duration_ms)}>{frame.duration_ms.toFixed(0)}ms</span>
                <span className="truncate" title={frame.url}>
                    <span className="text-muted-foreground mr-1.5">{frame.method}</span>
                    {frame.url}
                </span>
                <span className="text-muted-foreground truncate text-[10px]">{frame.operation ?? frame.source}</span>
            </div>
        );
    }

    if (frame.event === "crawl-progress") {
        return (
            <div className="grid grid-cols-[80px_60px_1fr_140px] gap-2 py-1 px-3 font-mono text-[11px] hover:bg-white/5 transition-colors border-b border-zinc-900/50">
                <span className="text-muted-foreground">{time}</span>
                <ShopBadge origin={frame.shop_origin} />
                <span className="truncate text-[var(--color-neon-cyan)]">
                    {frame.strategy} :: {frame.products_seen}/{frame.products_new}/{frame.prices_recorded}
                </span>
                <Badge
                    variant="outline"
                    className={`font-mono text-[10px] tracking-[0.15em] uppercase ${
                        frame.status === "completed"
                            ? "border-emerald-400/40 text-emerald-300"
                            : frame.status === "running"
                              ? "border-cyan-400/40 text-cyan-300"
                              : frame.status === "failed"
                                ? "border-rose-400/40 text-rose-300"
                                : "border-amber-400/40 text-amber-300"
                    }`}
                >
                    {frame.status}
                </Badge>
            </div>
        );
    }

    if (frame.event === "notification-fired") {
        return (
            <div className="grid grid-cols-[80px_60px_1fr_140px] gap-2 py-1 px-3 font-mono text-[11px] hover:bg-white/5 transition-colors border-b border-zinc-900/50">
                <span className="text-muted-foreground">{time}</span>
                <ShopBadge origin={frame.shop_origin} />
                <span className="truncate text-[var(--color-neon-amber)]">
                    {frame.title} — {frame.body}
                </span>
                <Badge
                    variant="outline"
                    className="font-mono text-[10px] tracking-[0.15em] uppercase border-amber-400/40 text-amber-300"
                >
                    notify
                </Badge>
            </div>
        );
    }

    return null;
}
