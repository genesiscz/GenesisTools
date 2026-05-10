import { ConnectKosikDialog } from "@app/shops/ui/components/ConnectKosikDialog";
import { ConnectRohlikDialog } from "@app/shops/ui/components/ConnectRohlikDialog";
import { ProviderCard, type ProviderCardData } from "@app/shops/ui/components/ProviderCard";
import { SafeJSON } from "@app/utils/json";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/providers")({
    component: ProvidersPage,
});

interface SyncResponse {
    synced: Array<{
        shop_origin: string;
        result?: { orders_new: number; items_matched: number };
        error?: string;
    }>;
}

interface ConnectResponse {
    ok: boolean;
    user_provider_id: number;
    external_user_email: string;
}

function ProvidersPage() {
    const qc = useQueryClient();
    const list = useQuery({
        queryKey: ["providers", "list"],
        queryFn: async () => (await fetch("/api/providers/list")).json() as Promise<ProviderCardData[]>,
    });

    const [openShop, setOpenShop] = useState<string | null>(null);

    const connect = useMutation<ConnectResponse, Error, { shop_origin: string; credentials: Record<string, unknown> }>({
        mutationFn: async (args) => {
            const res = await fetch("/api/providers/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(args),
            });
            const body = (await res.json()) as ConnectResponse | { error?: string };
            if (!res.ok) {
                throw new Error(("error" in body && body.error) || `connect failed (${res.status})`);
            }

            return body as ConnectResponse;
        },
        onSuccess: (body) => {
            toast.success(`Connected as ${body.external_user_email}`);
            qc.invalidateQueries({ queryKey: ["providers"] });
        },
    });

    const disconnect = useMutation({
        mutationFn: async (shop_origin: string) => {
            await fetch("/api/providers/disconnect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ shop_origin }),
            });
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
    });

    const sync = useMutation<SyncResponse, Error, string>({
        mutationFn: async (shop_origin) => {
            const res = await fetch("/api/providers/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ shop_origin }),
            });
            return (await res.json()) as SyncResponse;
        },
        onSuccess: (body) => {
            for (const r of body.synced) {
                if (r.error) {
                    toast.error(`${r.shop_origin}: ${r.error}`);
                } else if (r.result) {
                    toast.success(
                        `${r.shop_origin}: ${r.result.orders_new} new orders, ${r.result.items_matched} items matched`
                    );
                }
            }

            qc.invalidateQueries({ queryKey: ["providers"] });
        },
    });

    const toggleAuto = useMutation({
        mutationFn: async (args: { shop_origin: string; auto_watchlist: boolean }) => {
            await fetch("/api/providers/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify(args),
            });
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
    });

    return (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
            <h1 className="font-mono tracking-[0.3em] text-sm text-muted-foreground uppercase">
                Providers :: <span className="text-foreground">connect shop accounts</span>
            </h1>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {(list.data ?? []).map((p) => (
                    <ProviderCard
                        key={p.shop_origin}
                        data={p}
                        onConnect={() => setOpenShop(p.shop_origin)}
                        onDisconnect={() => disconnect.mutate(p.shop_origin)}
                        onSync={() => sync.mutate(p.shop_origin)}
                        onToggleAutoWatchlist={(next) =>
                            toggleAuto.mutate({ shop_origin: p.shop_origin, auto_watchlist: next })
                        }
                    />
                ))}
            </div>
            <ConnectRohlikDialog
                open={openShop === "rohlik.cz"}
                onClose={() => setOpenShop(null)}
                onSubmit={(creds) =>
                    connect.mutateAsync({ shop_origin: "rohlik.cz", credentials: creds }).then(() => undefined)
                }
            />
            <ConnectKosikDialog
                open={openShop === "kosik.cz"}
                onClose={() => setOpenShop(null)}
                onSubmit={(creds) =>
                    connect.mutateAsync({ shop_origin: "kosik.cz", credentials: creds }).then(() => undefined)
                }
            />
        </div>
    );
}
