import { SafeJSON } from "@app/utils/json";
import { Button } from "@app/utils/ui/components/button";
import { Input } from "@app/utils/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function PasteUrlQuickAdd() {
    const [url, setUrl] = useState("");
    const queryClient = useQueryClient();
    const mutation = useMutation({
        mutationFn: async (u: string) => {
            const res = await fetch("/api/watchlist/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ url: u }),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error ?? "Failed to add favorite");
            }

            return res.json();
        },
        onSuccess: () => {
            setUrl("");
            queryClient.invalidateQueries({ queryKey: ["watchlist"] });
            toast.success("Added to watchlist");
        },
        onError: (err: Error) => toast.error(err.message),
    });
    return (
        <form
            className="flex items-center gap-2 w-full md:w-auto"
            onSubmit={(e) => {
                e.preventDefault();
                if (url) {
                    mutation.mutate(url);
                }
            }}
        >
            <Input
                placeholder="Paste a product URL..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="font-mono flex-1 md:w-96 md:flex-none bg-zinc-950/60 border-zinc-700"
            />
            <Button type="submit" disabled={!url || mutation.isPending} className="font-mono">
                <Plus className="w-3.5 h-3.5 mr-1" />
                Watch
            </Button>
        </form>
    );
}
