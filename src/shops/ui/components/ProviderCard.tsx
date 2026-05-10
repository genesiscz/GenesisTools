import { Badge } from "@app/utils/ui/components/badge";
import { Button } from "@app/utils/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@app/utils/ui/components/card";
import { Switch } from "@app/utils/ui/components/switch";
import type { ReactNode } from "react";

export interface ProviderCardData {
    shop_origin: string;
    display_name: string;
    status: "connected" | "disconnected" | "expired" | "error";
    external_user_email: string | null;
    last_sync_at: string | null;
    last_sync_error: string | null;
    auto_watchlist: boolean;
    supports_auto_login: boolean;
}

interface Props {
    data: ProviderCardData;
    onConnect: () => void;
    onDisconnect: () => void;
    onSync: () => void;
    onToggleAutoWatchlist: (next: boolean) => void;
}

const statusVariant: Record<ProviderCardData["status"], "default" | "secondary" | "destructive" | "outline"> = {
    connected: "default",
    disconnected: "secondary",
    expired: "destructive",
    error: "destructive",
};

export function ProviderCard({
    data,
    onConnect,
    onDisconnect,
    onSync,
    onToggleAutoWatchlist,
}: Props): ReactNode {
    const isConnected = data.status === "connected";
    return (
        <Card className="border-zinc-800 bg-zinc-950">
            <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
                <CardTitle className="font-mono text-sm tracking-[0.25em] uppercase">
                    {data.display_name}
                </CardTitle>
                <Badge
                    variant={statusVariant[data.status]}
                    className="font-mono text-[10px] tracking-widest uppercase"
                >
                    {data.status}
                </Badge>
            </CardHeader>
            <CardContent className="space-y-3 text-xs font-mono text-muted-foreground">
                {isConnected ? (
                    <>
                        <div>
                            account: <span className="text-foreground">{data.external_user_email ?? "?"}</span>
                        </div>
                        <div>
                            last sync:{" "}
                            <span className="text-foreground">
                                {data.last_sync_at ? new Date(data.last_sync_at).toLocaleString() : "never"}
                            </span>
                        </div>
                        {data.last_sync_error ? (
                            <div className="text-[var(--color-neon-coral)]">error: {data.last_sync_error}</div>
                        ) : null}
                        <div className="flex items-center gap-2 pt-1">
                            <Switch
                                checked={data.auto_watchlist}
                                onCheckedChange={onToggleAutoWatchlist}
                                id={`auto-${data.shop_origin}`}
                            />
                            <label htmlFor={`auto-${data.shop_origin}`} className="text-xs">
                                Auto-add purchased items to watchlist
                            </label>
                        </div>
                        <div className="flex gap-2 pt-2">
                            <Button size="sm" onClick={onSync}>
                                Sync now
                            </Button>
                            <Button size="sm" variant="outline" onClick={onDisconnect}>
                                Disconnect
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <div>
                            {data.supports_auto_login
                                ? "Email + password login."
                                : "OAuth — paste session cookie."}
                        </div>
                        <Button size="sm" onClick={onConnect}>
                            Connect
                        </Button>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
