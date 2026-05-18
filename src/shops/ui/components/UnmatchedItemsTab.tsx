import { SafeJSON } from "@app/utils/json";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

export interface UnmatchedItem {
    order_id: number;
    line_no: number;
    name: string;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    total_price: number | null;
    external_product_id: string | null;
    shop_origin: string;
    ordered_at: string;
}

interface SearchResult {
    master_product_id: number;
    canonical_name: string;
}

export function UnmatchedItemsTab(): ReactNode {
    const qc = useQueryClient();
    const list = useQuery({
        queryKey: ["match", "my-unmatched"],
        queryFn: async () => (await fetch("/api/match/my-unmatched")).json() as Promise<UnmatchedItem[]>,
    });

    const attach = useMutation({
        mutationFn: async (args: { order_id: number; line_no: number; master_product_id: number }) => {
            const res = await fetch("/api/match/my-unmatched/attach", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(args),
            });
            if (!res.ok) {
                throw new Error(`attach failed (${res.status})`);
            }
        },
        onSuccess: () => {
            toast.success("Attached");
            qc.invalidateQueries({ queryKey: ["match", "my-unmatched"] });
        },
        onError: (err) => toast.error(err.message),
    });

    const rows = list.data ?? [];
    return (
        <div className="space-y-1">
            {rows.length === 0 ? (
                <div className="text-xs text-muted-foreground font-mono py-6 text-center">
                    no unmatched items in your orders
                </div>
            ) : (
                rows.map((r) => (
                    <UnmatchedRow
                        key={`${r.order_id}-${r.line_no}`}
                        item={r}
                        onAttach={(masterId) =>
                            attach.mutate({ order_id: r.order_id, line_no: r.line_no, master_product_id: masterId })
                        }
                    />
                ))
            )}
        </div>
    );
}

function UnmatchedRow({ item, onAttach }: { item: UnmatchedItem; onAttach: (masterId: number) => void }) {
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<SearchResult | null>(null);
    const search = useQuery({
        queryKey: ["search", query],
        queryFn: async (): Promise<SearchResult[]> => {
            if (query.length < 2) {
                return [];
            }

            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=5`);
            if (!res.ok) {
                return [];
            }

            const body = (await res.json()) as
                | { hits?: { type: string; id: number; name: string }[] }
                | { results?: SearchResult[] }
                | SearchResult[];
            if (Array.isArray(body)) {
                return body;
            }

            if ("hits" in body && Array.isArray(body.hits)) {
                return body.hits
                    .filter((h) => h.type === "master")
                    .map((h) => ({ master_product_id: h.id, canonical_name: h.name }));
            }

            return body.results ?? [];
        },
        enabled: query.length >= 2,
    });

    return (
        <div className="border border-border rounded p-2 flex flex-col md:flex-row gap-2 md:items-center">
            <div className="flex-1 min-w-0">
                <div className="text-xs font-mono text-foreground truncate">{item.name}</div>
                <div className="text-[10px] font-mono text-muted-foreground">
                    {item.shop_origin} · {new Date(item.ordered_at).toLocaleDateString("cs-CZ")} ·{" "}
                    {item.quantity ?? "?"} {item.unit ?? ""}
                </div>
            </div>
            <Input
                placeholder="Search master…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="md:w-64"
            />
            <select
                value={picked?.master_product_id ?? ""}
                onChange={(e) => {
                    const id = Number(e.target.value);
                    const found = search.data?.find((r) => r.master_product_id === id) ?? null;
                    setPicked(found);
                }}
                className="bg-card border border-border text-xs font-mono px-2 py-1 rounded md:w-64"
            >
                <option value="">— pick master —</option>
                {(search.data ?? []).map((r) => (
                    <option key={r.master_product_id} value={r.master_product_id}>
                        {r.canonical_name}
                    </option>
                ))}
            </select>
            <Button
                size="sm"
                disabled={picked === null}
                onClick={() => picked !== null && onAttach(picked.master_product_id)}
            >
                Attach
            </Button>
        </div>
    );
}
