import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

interface ProductLookupResponse {
    master_product_id: number | null;
    name: string;
    url: string;
}

export const Route = createFileRoute("/product/$shop/$slug")({
    component: ProductPage,
});

function ProductPage() {
    const { shop, slug } = Route.useParams();

    const lookupQuery = useQuery({
        queryKey: ["product-lookup", shop, slug],
        queryFn: async (): Promise<ProductLookupResponse> => {
            const res = await fetch(`/api/product/${encodeURIComponent(shop)}/${encodeURIComponent(slug)}`);
            if (!res.ok) {
                throw new Error(`product lookup failed: ${res.status}`);
            }

            return res.json();
        },
        retry: false,
    });

    return (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 text-center space-y-4">
            <div className="font-mono tracking-[0.3em] text-xs text-muted-foreground uppercase">
                Product :: {shop} / {slug}
            </div>
            {lookupQuery.isLoading && <div className="font-mono text-xs">looking up master link…</div>}
            {lookupQuery.error && (
                <div className="font-mono text-xs text-rose-400">
                    Not found in local DB. Try opening the upstream URL.
                </div>
            )}
            {lookupQuery.data && lookupQuery.data.master_product_id !== null && (
                <Link
                    to="/master/$id"
                    params={{ id: String(lookupQuery.data.master_product_id) }}
                    className="inline-block font-mono text-sm text-[var(--color-neon-cyan)] underline tracking-[0.15em] uppercase"
                >
                    Open master :: {lookupQuery.data.name}
                </Link>
            )}
            {lookupQuery.data && lookupQuery.data.master_product_id === null && (
                <div className="space-y-2">
                    <div className="font-mono text-xs text-amber-400 tracking-[0.15em] uppercase">
                        Pending master link
                    </div>
                    <a
                        href={lookupQuery.data.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block font-mono text-xs text-[var(--color-neon-cyan)] underline"
                    >
                        Open upstream
                    </a>
                </div>
            )}
        </div>
    );
}
