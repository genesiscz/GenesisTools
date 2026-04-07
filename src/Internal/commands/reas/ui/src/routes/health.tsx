import type { ProviderFetchLogRow, ProviderHealthSummary } from "@app/Internal/commands/reas/lib/store";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Skeleton } from "@ui/components/skeleton";
import { Activity } from "lucide-react";
import { ProviderHealthDashboard } from "../components/health/ProviderHealthDashboard";

export const Route = createFileRoute("/health")({
    component: HealthPage,
});

interface HealthResponse {
    health: ProviderHealthSummary[];
    recentLog: ProviderFetchLogRow[];
}

function useProviderHealth(days = 30) {
    return useQuery<HealthResponse>({
        queryKey: ["provider-health", days],
        queryFn: async () => {
            const res = await fetch(`/api/provider-health?days=${days}`);

            if (!res.ok) {
                throw new Error("Failed to fetch provider health");
            }

            return res.json();
        },
        refetchInterval: 60_000,
    });
}

function HealthPage() {
    const { data, isLoading, error } = useProviderHealth();

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
            <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30">
                    <Activity className="h-5 w-5 text-cyan-400" />
                </div>
                <div>
                    <h1 className="text-xl font-mono font-bold text-gray-200">Provider Health</h1>
                    <p className="text-xs font-mono text-gray-500">
                        Real-time monitoring of all data provider endpoints
                    </p>
                </div>
            </div>

            {isLoading ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-48 rounded-xl bg-white/5" />
                    ))}
                </div>
            ) : error ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-6 text-center">
                    <p className="font-mono text-sm text-red-300">
                        {error instanceof Error ? error.message : "Failed to load health data"}
                    </p>
                </div>
            ) : data ? (
                <ProviderHealthDashboard health={data.health} recentLog={data.recentLog} />
            ) : null}
        </div>
    );
}
