import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PortsTable } from "@/components/port-killer/PortsTable";
import { expectedKillCommand, usePorts } from "@/hooks/usePorts";
import { portsApi } from "@/lib/api";

export function PortKillerRoute() {
    const queryClient = useQueryClient();
    const { data } = usePorts();

    const killMutation = useMutation({
        mutationFn: (port: PortInfo) => portsApi.kill(port.pid, expectedKillCommand(port)),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["ports"] });
        },
    });

    const handleKill = (port: PortInfo) => {
        const label = port.title ?? port.command;
        if (window.confirm(`Kill :${port.port} — ${label} (pid ${port.pid})?`)) {
            killMutation.mutate(port);
        }
    };

    return (
        <div className="h-[calc(100vh-2rem)] overflow-auto">
            {data ? (
                <PortsTable
                    result={data}
                    onKill={handleKill}
                    killingPid={killMutation.isPending ? (killMutation.variables?.pid ?? null) : null}
                />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Scanning ports...
                </div>
            )}
        </div>
    );
}
