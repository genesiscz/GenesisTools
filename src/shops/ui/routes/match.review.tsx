import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader } from "@app/utils/ui/components/card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { GitMerge } from "lucide-react";
import { toast } from "sonner";
import type { PairDTO, ProductSummary } from "../../lib/match-api";
import { EmptyState } from "../components/EmptyState";

export const Route = createFileRoute("/match/review")({
    component: MatchReviewPage,
});

function MatchReviewPage() {
    const queryClient = useQueryClient();
    const data = useQuery({
        queryKey: ["match-candidates"],
        queryFn: async () => (await fetch("/api/match/candidates")).json() as Promise<PairDTO[]>,
    });
    const accept = useMutation({
        mutationFn: async (pair: PairDTO) =>
            fetch(`/api/match/${pair.productIdA}-${pair.productIdB}/accept`, { method: "POST" }),
        onSuccess: () => {
            toast.success("Pair accepted; masters merged.");
            queryClient.invalidateQueries({ queryKey: ["match-candidates"] });
        },
    });
    const reject = useMutation({
        mutationFn: async (pair: PairDTO) =>
            fetch(`/api/match/${pair.productIdA}-${pair.productIdB}/reject`, { method: "POST" }),
        onSuccess: () => {
            toast("Pair rejected.");
            queryClient.invalidateQueries({ queryKey: ["match-candidates"] });
        },
    });

    const pairs = data.data ?? [];

    return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Match :: <span className="text-foreground">{pairs.length} pending</span>
            </h1>
            {pairs.length === 0 ? (
                <EmptyState
                    icon={<GitMerge />}
                    title="All caught up"
                    body="No pending merge candidates. New gray-zone pairs surface here when the auto-matcher isn't sure whether two products are the same SKU."
                />
            ) : (
                <div className="grid gap-3">
                    {pairs.map((pair) => (
                        <PairCard
                            key={`${pair.productIdA}-${pair.productIdB}`}
                            pair={pair}
                            onAccept={() => accept.mutate(pair)}
                            onReject={() => reject.mutate(pair)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface PairCardProps {
    pair: PairDTO;
    onAccept: () => void;
    onReject: () => void;
}

function PairCard({ pair, onAccept, onReject }: PairCardProps) {
    return (
        <Card className="bg-zinc-950/40 border-zinc-800/60">
            <CardHeader className="flex flex-row items-center justify-between font-mono py-3 px-4">
                <span className="text-xs uppercase tracking-wider text-zinc-500">
                    similarity · <span className="text-cyan-300">{pair.similarity.toFixed(3)}</span>
                </span>
                <Badge variant="secondary" className="font-mono text-[10px]">
                    {pair.method}
                </Badge>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 px-4 pb-3">
                <ProductPanel product={pair.productA} />
                <ProductPanel product={pair.productB} />
            </CardContent>
            <CardFooter className="flex gap-2 justify-end px-4 pb-3">
                <Button size="sm" variant="outline" onClick={onReject} className="font-mono">
                    Reject
                </Button>
                <Button size="sm" onClick={onAccept} className="font-mono">
                    Accept (merge)
                </Button>
            </CardFooter>
        </Card>
    );
}

function ProductPanel({ product }: { product: ProductSummary }) {
    return (
        <article className="space-y-1 font-mono">
            <Badge variant="outline" className="font-mono text-[10px]">
                {product.shop_origin}
            </Badge>
            <h3 className="font-medium text-zinc-100 text-sm leading-snug">{product.name}</h3>
            <dl className="text-xs text-zinc-500 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                <dt>brand</dt>
                <dd className="text-zinc-300">{product.brand ?? "—"}</dd>
                <dt>size</dt>
                <dd className="text-zinc-300">
                    {product.unit_amount ?? "?"}
                    {product.unit ?? ""}
                </dd>
                <dt>flavor</dt>
                <dd className="text-zinc-300">{product.flavor_key ?? "—"}</dd>
                <dt>ean</dt>
                <dd className="text-zinc-300">{product.ean ?? "—"}</dd>
            </dl>
            {product.image_url && (
                <img
                    src={product.image_url}
                    alt=""
                    className="w-20 h-20 object-cover rounded border border-zinc-800 mt-1"
                />
            )}
        </article>
    );
}
