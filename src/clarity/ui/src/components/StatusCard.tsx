import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { Globe, Link2, Shield, User } from "lucide-react";
import type { StatusResult } from "../server/settings";

async function fetchStatus(): Promise<StatusResult> {
    const res = await fetch("/api/status");

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to fetch status (${res.status})`);
    }

    return res.json();
}

interface StatusCardProps {
    /** Compact mode for homepage — fewer details */
    compact?: boolean;
}

function StatusDot({ ok }: { ok: boolean }) {
    return <div className={`w-2 h-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />;
}

function AuthBadge({ hasAuth }: { hasAuth: boolean }) {
    return hasAuth ? (
        <Badge variant="outline" className="text-xs border-green-500/30 text-green-400">
            Active
        </Badge>
    ) : (
        <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
            Missing
        </Badge>
    );
}

export function StatusCard({ compact }: StatusCardProps) {
    const {
        data: status,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["status"],
        queryFn: fetchStatus,
        staleTime: 30_000,
    });

    if (isLoading) {
        return (
            <Card className="border-amber-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        System status
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                        <Skeleton variant="line" />
                        <Skeleton variant="line" />
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <Card className="border-red-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        System status
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-red-400 font-mono text-sm">
                        {error instanceof Error ? error.message : "Failed to fetch status"}
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (!status) {
        return null;
    }

    if (compact) {
        return (
            <Card className="border-amber-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        System status
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                        <div className="flex items-center gap-2">
                            <StatusDot ok={status.configured} />
                            <span className="text-xs font-mono text-gray-400">Clarity</span>
                            <Badge variant="outline" className="text-xs">
                                {status.configured ? "Configured" : "Not configured"}
                            </Badge>
                        </div>
                        <div className="flex items-center gap-2">
                            <StatusDot ok={status.hasAuth} />
                            <span className="text-xs font-mono text-gray-400">Auth</span>
                            <AuthBadge hasAuth={status.hasAuth} />
                        </div>
                        <div className="flex items-center gap-2">
                            <Link2 className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-xs font-mono text-gray-400">
                                {status.mappingsCount} mapping{status.mappingsCount !== 1 ? "s" : ""}
                            </span>
                        </div>
                        {status.uniqueName && (
                            <div className="flex items-center gap-2">
                                <User className="w-3.5 h-3.5 text-gray-500" />
                                <span className="text-xs font-mono text-gray-400">{status.uniqueName}</span>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="border-amber-500/20">
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    Connection status
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="space-y-3">
                    <div className="flex items-center gap-3">
                        <StatusDot ok={status.configured} />
                        <span className="font-mono text-sm text-gray-300">
                            {status.configured ? "Configured" : "Not configured"}
                        </span>
                    </div>

                    {status.baseUrl && (
                        <div className="flex items-center gap-3">
                            <Globe className="w-4 h-4 text-gray-500" />
                            <span className="font-mono text-sm text-gray-400">{status.baseUrl}</span>
                        </div>
                    )}

                    <div className="flex items-center gap-3">
                        <Shield className="w-4 h-4 text-gray-500" />
                        <span className="font-mono text-sm text-gray-400">
                            Auth: <AuthBadge hasAuth={status.hasAuth} />
                        </span>
                    </div>

                    <div className="flex items-center gap-3">
                        <Link2 className="w-4 h-4 text-gray-500" />
                        <span className="font-mono text-sm text-gray-400">Mappings: {status.mappingsCount}</span>
                    </div>

                    {status.uniqueName && (
                        <div className="flex items-center gap-3">
                            <User className="w-4 h-4 text-gray-500" />
                            <span className="font-mono text-sm text-gray-400">{status.uniqueName}</span>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
