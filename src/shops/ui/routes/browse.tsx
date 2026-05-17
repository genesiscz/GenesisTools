import type { MasterListResponse } from "@app/shops/types";
import { BrowseGrid } from "@app/shops/ui/components/BrowseGrid";
import { useDebouncedValue } from "@app/shops/ui/hooks/useDebouncedValue";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@app/utils/ui/components/select";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { useState } from "react";

interface BrowseSearch {
    q?: string;
    brand?: string;
    sort?: "best_price" | "total_offers" | "name";
    order?: "asc" | "desc";
    page?: number;
}

const PAGE_SIZE = 50;

export const Route = createFileRoute("/browse")({
    validateSearch: (search: Record<string, unknown>): BrowseSearch => ({
        q: typeof search.q === "string" ? search.q : undefined,
        brand: typeof search.brand === "string" ? search.brand : undefined,
        sort: ["best_price", "total_offers", "name"].includes(search.sort as string)
            ? (search.sort as BrowseSearch["sort"])
            : undefined,
        order: ["asc", "desc"].includes(search.order as string) ? (search.order as BrowseSearch["order"]) : undefined,
        page: typeof search.page === "number" ? search.page : undefined,
    }),
    component: BrowsePage,
});

interface SearchResponseHit {
    type: string;
    id: number;
    name: string;
    brand: string | null;
    image_url: string | null;
    best_price: number | null;
    total_offers: number | null;
    best_price_shop: string | null;
}

function BrowsePage() {
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    const [qInput, setQInput] = useState(search.q ?? "");
    const debouncedQ = useDebouncedValue(qInput, 250);
    const page = search.page ?? 1;
    const sort = search.sort ?? "name";
    const order = search.order ?? "asc";

    const masterQuery = useQuery({
        queryKey: ["master", { q: debouncedQ, brand: search.brand, sort, order, page }],
        queryFn: async (): Promise<MasterListResponse> => {
            const params = new URLSearchParams();
            params.set("limit", String(PAGE_SIZE));
            params.set("offset", String((page - 1) * PAGE_SIZE));
            params.set("sort", sort);
            params.set("order", order);
            if (search.brand) {
                params.set("brand", search.brand);
            }

            const url =
                debouncedQ.length >= 2
                    ? `/api/search?q=${encodeURIComponent(debouncedQ)}&limit=${PAGE_SIZE}`
                    : `/api/master?${params.toString()}`;
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`master fetch failed: ${res.status}`);
            }

            const body = await res.json();

            if (debouncedQ.length >= 2) {
                const hits = (body.hits ?? []) as SearchResponseHit[];
                return {
                    items: hits
                        .filter((h) => h.type === "master")
                        .map((h) => ({
                            id: h.id,
                            canonical_name: h.name,
                            canonical_slug: "",
                            brand: h.brand,
                            representative_image_url: h.image_url,
                            total_offers: h.total_offers ?? 0,
                            best_price: h.best_price,
                            best_price_shop: h.best_price_shop,
                            master_category_id: null,
                        })),
                    total: hits.length,
                    limit: PAGE_SIZE,
                    offset: 0,
                };
            }

            return body as MasterListResponse;
        },
    });

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                    Browse :: <span className="text-foreground">Master Catalog</span>
                </h1>
                <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <Input
                            value={qInput}
                            onChange={(e) => setQInput(e.target.value)}
                            placeholder="search products"
                            className="pl-8 w-56 font-mono text-xs"
                        />
                        {qInput && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setQInput("")}
                                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                            >
                                <X className="w-3 h-3" />
                            </Button>
                        )}
                    </div>
                    <Select
                        value={`${sort}:${order}`}
                        onValueChange={(v) => {
                            const [s, o] = v.split(":") as [BrowseSearch["sort"], BrowseSearch["order"]];
                            navigate({ search: { ...search, sort: s, order: o, page: 1 } });
                        }}
                    >
                        <SelectTrigger className="w-44 font-mono text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="name:asc">Name A→Z</SelectItem>
                            <SelectItem value="name:desc">Name Z→A</SelectItem>
                            <SelectItem value="best_price:asc">Best price ↑</SelectItem>
                            <SelectItem value="best_price:desc">Best price ↓</SelectItem>
                            <SelectItem value="total_offers:desc">Most shops</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <BrowseGrid
                data={masterQuery.data}
                isLoading={masterQuery.isLoading}
                page={page}
                onPageChange={(p) => navigate({ search: { ...search, page: p } })}
            />
        </div>
    );
}
