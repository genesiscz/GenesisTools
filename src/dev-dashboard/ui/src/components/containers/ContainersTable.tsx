import type { ContainerInfo, ContainersResult } from "@app/dev-dashboard/lib/containers/types";

interface ContainersTableProps {
    result: ContainersResult;
}

function stateColor(state: string): string {
    if (state === "running") {
        return "#34d399";
    }

    if (state === "exited") {
        return "#f87171";
    }

    return "var(--dd-text-muted)";
}

function sortRunningFirst(containers: ContainerInfo[]): ContainerInfo[] {
    return [...containers].sort((a, b) => {
        const aRunning = a.state === "running" ? 0 : 1;
        const bRunning = b.state === "running" ? 0 : 1;
        return aRunning - bRunning;
    });
}

export function ContainersTable({ result }: ContainersTableProps) {
    if (!result.dockerAvailable) {
        return (
            <div className="dd-panel flex h-full items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                Docker / OrbStack not detected — start it and this panel will populate.
            </div>
        );
    }

    const containers = sortRunningFirst(result.containers);

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <h3 className="dd-accent-text text-lg font-semibold">Containers</h3>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-[var(--dd-text-secondary)]">
                            <th className="px-2 py-2 font-medium">State</th>
                            <th className="px-2 py-2 font-medium">Name</th>
                            <th className="px-2 py-2 font-medium">Image</th>
                            <th className="px-2 py-2 font-medium">Status</th>
                            <th className="px-2 py-2 font-medium">Ports</th>
                        </tr>
                    </thead>
                    <tbody>
                        {containers.map((c) => (
                            <tr key={c.id} className="border-t border-[var(--dd-border)] text-[var(--dd-text-primary)]">
                                <td className="px-2 py-2">
                                    <span
                                        className="inline-block h-2.5 w-2.5 rounded-full"
                                        style={{ backgroundColor: stateColor(c.state) }}
                                        title={c.state}
                                    />
                                </td>
                                <td className="px-2 py-2">{c.name}</td>
                                <td className="px-2 py-2 text-[var(--dd-text-secondary)]">{c.image}</td>
                                <td className="px-2 py-2 text-[var(--dd-text-secondary)]">{c.status}</td>
                                <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)]">
                                    {c.ports ? c.ports : "—"}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {containers.length === 0 ? (
                    <p className="px-2 py-4 text-[var(--dd-text-muted)]">No containers.</p>
                ) : null}
            </div>
        </div>
    );
}
