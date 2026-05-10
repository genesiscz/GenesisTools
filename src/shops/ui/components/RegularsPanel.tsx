import type { RecurringPurchase } from "@app/shops/lib/analytics/recurring";
import { Badge } from "@app/utils/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import type { ReactNode } from "react";

interface Props {
    items: RecurringPurchase[];
    onOpen: (masterId: number) => void;
}

const CONFIDENCE_VARIANT: Record<RecurringPurchase["confidence"], "default" | "secondary" | "outline"> = {
    high: "default",
    medium: "secondary",
    low: "outline",
};

function daysUntil(iso: string): number {
    return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export function RegularsPanel({ items, onOpen }: Props): ReactNode {
    if (items.length === 0) {
        return null;
    }

    return (
        <Card className="border-zinc-800 bg-zinc-950">
            <CardHeader>
                <CardTitle className="font-mono text-[10px] tracking-[0.25em] uppercase text-muted-foreground">
                    REGULARS · {items.length}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
                {items.slice(0, 8).map((it) => {
                    const d = daysUntil(it.next_likely_at);
                    const dueLabel = d <= 0 ? `due now` : d === 1 ? `buy in ~1 day` : `buy in ~${d} days`;
                    return (
                        <button
                            key={it.master_product_id}
                            type="button"
                            onClick={() => onOpen(it.master_product_id)}
                            className="w-full flex justify-between items-center text-left text-xs font-mono py-1.5 px-2 rounded hover:bg-white/5"
                        >
                            <span className="truncate text-foreground">{it.name}</span>
                            <span className="flex items-center gap-2 shrink-0">
                                <span className="text-muted-foreground tabular-nums">{dueLabel}</span>
                                <Badge
                                    variant={CONFIDENCE_VARIANT[it.confidence]}
                                    className="text-[9px] tracking-widest"
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
