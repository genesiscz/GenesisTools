import type { SearchResponse } from "@app/shops/types";
import { ShopBadge } from "@app/shops/ui/components/ShopBadge";
import { useDebouncedValue } from "@app/shops/ui/hooks/useDebouncedValue";
import { Input } from "@app/utils/ui/components/input";
import { Skeleton } from "@app/utils/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImageOff, Search } from "lucide-react";
import { useState } from "react";

interface ProductSearchPanelProps {
    onSelect?: (id: number, type: "master" | "product") => void;
}

export function ProductSearchPanel({ onSelect }: ProductSearchPanelProps) {
    const [query, setQuery] = useState("");
    const debounced = useDebouncedValue(query, 250);

    const searchQuery = useQuery({
        queryKey: ["search", debounced],
        queryFn: async (): Promise<SearchResponse> => {
            const res = await fetch(`/api/search?q=${encodeURIComponent(debounced)}&limit=30`);
            if (!res.ok) {
                throw new Error(`search failed: ${res.status}`);
            }

            return res.json();
        },
        enabled: debounced.length >= 2,
    });

    return (
        <div className="h-full flex flex-col">
            <div className="relative px-3 py-2 border-b border-zinc-800">
                <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search products"
                    className="pl-8 font-mono text-xs"
                />
            </div>
            <div className="flex-1 overflow-y-auto">
                {debounced.length < 2 ? (
                    <div className="p-12 text-center font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
                        type to search
                    </div>
                ) : searchQuery.isLoading ? (
                    <div className="space-y-1 p-2">
                        {Array.from({ length: 8 }, (_, i) => (
                            <Skeleton key={i} className="h-12 w-full" />
                        ))}
                    </div>
                ) : !searchQuery.data || searchQuery.data.hits.length === 0 ? (
                    <div className="p-12 text-center font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
                        no hits
                    </div>
                ) : (
                    <ul className="divide-y divide-zinc-900/50">
                        {searchQuery.data.hits.map((hit) => {
                            const inner = (
                                <div className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors">
                                    <div className="w-10 h-10 bg-zinc-900 border border-zinc-800 rounded overflow-hidden flex items-center justify-center shrink-0">
                                        {hit.image_url ? (
                                            <img
                                                src={hit.image_url}
                                                alt={hit.name}
                                                className="w-full h-full object-contain"
                                            />
                                        ) : (
                                            <ImageOff className="w-4 h-4 text-zinc-700" />
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="font-mono text-xs text-foreground truncate">{hit.name}</div>
                                        <div className="flex items-center gap-2 mt-0.5">
                                            <span className="font-mono text-[10px] text-muted-foreground">
                                                {hit.brand ?? "—"}
                                            </span>
                                            {hit.shop_origin ? (
                                                <ShopBadge origin={hit.shop_origin} />
                                            ) : (
                                                <span className="font-mono text-[10px] text-cyan-300 tracking-[0.15em] uppercase">
                                                    master
                                                </span>
                                            )}
                                            {hit.best_price !== null && (
                                                <span className="font-mono text-[10px] text-[var(--color-neon-cyan)]">
                                                    {hit.best_price.toFixed(2)} Kč
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );

                            const linkProps =
                                hit.type === "master"
                                    ? { to: "/master/$id" as const, params: { id: String(hit.id) } }
                                    : {
                                          to: "/product/$shop/$slug" as const,
                                          params: { shop: hit.shop_origin ?? "", slug: hit.slug ?? "" },
                                      };

                            return (
                                <li key={`${hit.type}-${hit.id}`}>
                                    {onSelect ? (
                                        <button
                                            type="button"
                                            onClick={() => onSelect(hit.id, hit.type)}
                                            className="w-full text-left"
                                        >
                                            {inner}
                                        </button>
                                    ) : (
                                        <Link {...linkProps} className="block">
                                            {inner}
                                        </Link>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
