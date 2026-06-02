import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";

interface PortsTableProps {
    result: PortsResult;
    onKill: (port: PortInfo) => void;
    killingPid: number | null;
}

function protoLabel(proto: PortInfo["proto"]): string {
    return proto === "tcp6" ? "IPv6" : "IPv4";
}

function sortByPortAsc(ports: PortInfo[]): PortInfo[] {
    return [...ports].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

export function PortsTable({ result, onKill, killingPid }: PortsTableProps) {
    if (!result.lsofAvailable) {
        return (
            <div className="dd-panel flex h-full items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                lsof is not available on this host — listening ports can't be enumerated.
            </div>
        );
    }

    const ports = sortByPortAsc(result.ports);

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <h3 className="dd-accent-text text-lg font-semibold">Listening ports ({ports.length})</h3>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-[var(--dd-text-secondary)]">
                            <th className="px-2 py-2 font-medium">Port</th>
                            <th className="px-2 py-2 font-medium">Proto</th>
                            <th className="px-2 py-2 font-medium">Command</th>
                            <th className="px-2 py-2 font-medium">PID</th>
                            <th className="px-2 py-2 font-medium">Address</th>
                            <th className="px-2 py-2 font-medium" />
                        </tr>
                    </thead>
                    <tbody>
                        {ports.map((p) => (
                            <tr
                                key={`${p.pid}-${p.port}-${p.proto}`}
                                className="border-t border-[var(--dd-border)] text-[var(--dd-text-primary)]"
                            >
                                <td className="px-2 py-2 font-mono font-medium text-[var(--dd-accent)]">:{p.port}</td>
                                <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)]">
                                    {protoLabel(p.proto)}
                                </td>
                                <td className="px-2 py-2 font-medium">{p.command}</td>
                                <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)]">{p.pid}</td>
                                <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-secondary)]">
                                    {p.address}
                                </td>
                                <td className="px-2 py-2 text-right">
                                    <button
                                        type="button"
                                        onClick={() => onKill(p)}
                                        disabled={killingPid === p.pid}
                                        className="rounded-md border border-[var(--dd-border)] px-3 py-1 text-xs font-semibold transition-colors hover:border-[#f87171] disabled:opacity-50"
                                        style={{ color: "#f87171" }}
                                    >
                                        {killingPid === p.pid ? "Killing…" : "Kill"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {ports.length === 0 ? (
                    <p className="px-2 py-4 text-[var(--dd-text-muted)]">No listening ports.</p>
                ) : null}
            </div>
        </div>
    );
}
