import { SafeJSON } from "@app/utils/json";
import { Button } from "@app/utils/ui/components/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { toast } from "sonner";

interface StarWatchButtonProps {
    masterProductId: number;
    isFavorite?: boolean;
}

export function StarWatchButton({ masterProductId, isFavorite = false }: StarWatchButtonProps) {
    const queryClient = useQueryClient();

    const addMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/watchlist/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ master_product_id: masterProductId }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({ error: "unknown error" }));
                throw new Error(body.error ?? `add failed: ${res.status}`);
            }

            return res.json();
        },
        onSuccess: () => {
            toast.success("Added to watchlist");
            queryClient.invalidateQueries({ queryKey: ["watchlist"] });
        },
        onError: (err: Error) => {
            toast.error(err.message);
        },
    });

    return (
        <Button
            variant="outline"
            size="sm"
            onClick={() => addMutation.mutate()}
            disabled={isFavorite || addMutation.isPending}
            className="font-mono text-xs tracking-[0.15em] uppercase"
        >
            <Heart className={`w-3.5 h-3.5 mr-1.5 ${isFavorite ? "fill-current text-rose-400" : ""}`} />
            {isFavorite ? "Watched" : "Watch"}
        </Button>
    );
}
