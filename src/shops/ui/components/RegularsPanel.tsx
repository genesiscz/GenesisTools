import type { RecurringPurchase } from "@app/shops/lib/analytics/recurring";
import { Badge } from "@app/utils/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { cn } from "@app/utils/ui/lib/utils";
import type { ReactNode } from "react";

interface Props {
    items: RecurringPurchase[];
    onOpen: (masterId: number) => void;
}

const CONFIDENCE_CLASSES: Record<RecurringPurchase["confidence"], string> = {
    high: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    medium: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    low: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
};

function daysUntil(iso: string): number {
    return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function RegularsPanel({ items, onOpen }: Props): ReactNode {
    if (items.length === 0) {
        return null;
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="font-mono text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
                    REGULARS · {items.length}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
                {items.slice(0, 8).map((it) => {
                    const d = daysUntil(it.next_likely_at);
                    const dueNow = d <= 0;
                    const dueLabel = dueNow ? `● due now` : d === 1 ? `buy in ~1 day` : `buy in ~${d} days`;
                    return (
                        <button
                            key={it.master_product_id}
                            type="button"
                            onClick={() => onOpen(it.master_product_id)}
                            className={cn(
                                "w-full flex justify-between items-center text-left text-xs font-mono py-1.5 px-2 rounded border-l-2 border-transparent transition-colors hover:bg-cyan-500/5 hover:border-cyan-500/40",
                                dueNow && "text-[var(--color-neon-cyan)]/90"
                            )}
                        >
                            <span className="truncate">{it.name}</span>
                            <span className="flex items-center gap-2 shrink-0">
                                <span
                                    className={cn(
                                        "tabular-nums",
                                        dueNow ? "text-[var(--color-neon-cyan)]" : "text-muted-foreground"
                                    )}
                                >
                                    {dueLabel}
                                </span>
                                <Badge
                                    variant="outline"
                                    className={cn(
                                        "text-[9px] tracking-widest border",
                                        CONFIDENCE_CLASSES[it.confidence]
                                    )}
                                >
                                    {it.confidence}
                                </Badge>
                                <span className="text-muted-foreground/70 tabular-nums">~{it.avg_interval_days}d</span>
                            </span>
                        </button>
                    );
                })}
            </CardContent>
        </Card>
    );
}
