import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Checkbox } from "@app/utils/ui/components/checkbox";
import { type ReactNode, useState } from "react";

export interface OrderRow {
    id: number;
    external_order_id: string;
    ordered_at: string;
    total_amount: number;
    currency: string;
    items: {
        line_no: number;
        name: string;
        external_product_id: string | null;
        quantity: number | null;
        unit_price: number | null;
        total_price: number | null;
        master_product_id: number | null;
    }[];
}

export interface ProviderOrders {
    shop_origin: string;
    orders: OrderRow[];
}

interface Props {
    providers: ProviderOrders[];
    onBulkAdd: (items: { master_product_id: number }[]) => Promise<void>;
}

export function BulkAddOrdersTable({ providers, onBulkAdd }: Props): ReactNode {
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [submitting, setSubmitting] = useState(false);

    function toggle(masterId: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(masterId)) {
                next.delete(masterId);
            } else {
                next.add(masterId);
            }

            return next;
        });
    }

    async function submit() {
        setSubmitting(true);
        try {
            await onBulkAdd([...selected].map((master_product_id) => ({ master_product_id })));
            setSelected(new Set());
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="space-y-3">
            {providers.map((p) => (
                <Card key={p.shop_origin}>
                    <CardHeader>
                        <CardTitle className="font-mono text-xs tracking-[0.25em] uppercase text-muted-foreground">
                            {p.shop_origin} · {p.orders.length} orders
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {p.orders.map((o) => (
                            <div key={o.id} className="border border-border rounded">
                                <div className="px-3 py-1.5 border-b border-border flex justify-between text-xs font-mono">
                                    <span className="text-muted-foreground">
                                        #{o.external_order_id} · {new Date(o.ordered_at).toLocaleDateString("cs-CZ")}
                                    </span>
                                    <span className="text-foreground tabular-nums">
                                        {o.total_amount.toLocaleString("cs-CZ")} {o.currency}
                                    </span>
                                </div>
                                <ul className="text-xs font-mono divide-y divide-border">
                                    {o.items.map((it) => (
                                        <li key={it.line_no} className="flex items-center gap-3 px-3 py-1.5">
                                            <Checkbox
                                                disabled={it.master_product_id === null}
                                                checked={
                                                    it.master_product_id !== null && selected.has(it.master_product_id)
                                                }
                                                onCheckedChange={() => {
                                                    if (it.master_product_id !== null) {
                                                        toggle(it.master_product_id);
                                                    }
                                                }}
                                            />
                                            <span className="flex-1 truncate text-foreground">{it.name}</span>
                                            {it.master_product_id === null ? (
                                                <span className="text-[10px] text-muted-foreground">unmatched</span>
                                            ) : null}
                                            <span className="text-muted-foreground tabular-nums w-20 text-right">
                                                {it.quantity ?? "—"} ks
                                            </span>
                                            <span className="text-muted-foreground tabular-nums w-24 text-right">
                                                {it.total_price?.toLocaleString("cs-CZ") ?? "—"}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            ))}
            <div className="sticky bottom-2 bg-background/80 backdrop-blur-md border border-border rounded p-2 flex justify-between items-center">
                <span className="text-xs font-mono text-muted-foreground">{selected.size} selected</span>
                <Button size="sm" disabled={selected.size === 0 || submitting} onClick={submit}>
                    {submitting ? "..." : `Add ${selected.size} to watchlist`}
                </Button>
            </div>
        </div>
    );
}
