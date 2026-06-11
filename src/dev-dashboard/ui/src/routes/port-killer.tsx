import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PortsTable } from "@/components/port-killer/PortsTable";
import { portsApi } from "@/lib/api";

export function PortKillerRoute() {
    const queryClient = useQueryClient();

    const { data } = useQuery<PortsResult>({
        queryKey: ["ports"],
        queryFn: () => portsApi.list(),
        refetchInterval: 8000,
    });

    const killMutation = useMutation({
        mutationFn: (port: PortInfo) => portsApi.kill(port.pid, port.command),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["ports"] });
        },
    });

    const handleKill = (port: PortInfo) => {
        if (window.confirm(`Kill :${port.port} — ${port.command} (pid ${port.pid})?`)) {
            killMutation.mutate(port);
        }
    };

    return (
        <div className="h-[calc(100vh-2rem)]">
            {data ? (
                <PortsTable
                    result={data}
                    onKill={handleKill}
                    killingPid={killMutation.isPending ? killMutation.variables?.pid ?? null : null}
                />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Scanning ports...
                </div>
            )}
        </div>
    );
}
