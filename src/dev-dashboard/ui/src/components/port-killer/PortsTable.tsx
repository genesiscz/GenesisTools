import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { fuzzySearchByHaystack } from "@app/utils/fuzzy-search";
import { useState } from "react";
import { SearchInput } from "@/components/SearchInput";

interface PortsTableProps {
    result: PortsResult;
    onKill: (port: PortInfo) => void;
    killingPid: number | null;
}

function portHaystack(p: PortInfo): string {
    return [p.port, p.command, p.fullCommand, p.title, p.pid, p.address].filter(Boolean).join(" ");
}

function protoLabel(proto: PortInfo["proto"]): string {
    return proto === "tcp6" ? "IPv6" : "IPv4";
}

function sortByPortAsc(ports: PortInfo[]): PortInfo[] {
    return [...ports].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

export function PortsTable({ result, onKill, killingPid }: PortsTableProps) {
    const [query, setQuery] = useState("");

    if (!result.lsofAvailable) {
        return (
            <div className="dd-panel flex h-full items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                lsof is not available on this host — listening ports can't be enumerated.
            </div>
        );
    }

    const sorted = sortByPortAsc(result.ports);
    const ports = fuzzySearchByHaystack(sorted, query, portHaystack).items;

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <div className="flex items-center justify-between gap-4">
                <h3 className="dd-accent-text text-lg font-semibold">
                    Listening ports ({ports.length}
                    {query ? ` / ${sorted.length}` : ""})
                </h3>
                <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search ports — command, pid, address…"
                    className="max-w-xs"
                />
            </div>
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
                                <td className="px-2 py-2">
                                    <div className="flex items-baseline gap-2">
                                        <span className="font-medium">{p.command}</span>
                                        {p.title ? (
                                            <span className="truncate text-xs text-[var(--dd-accent)]">{p.title}</span>
                                        ) : null}
                                    </div>
                                    {p.fullCommand ? (
                                        <div
                                            title={p.fullCommand}
                                            className="max-w-[36ch] truncate font-mono text-xs text-[var(--dd-text-muted)]"
                                        >
                                            {p.fullCommand}
                                        </div>
                                    ) : null}
                                </td>
                                <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)]">{p.pid}</td>
                                <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-secondary)]">
                                    {p.address}
                                </td>
                                <td className="px-2 py-2 text-right">
                                    <button
                                        type="button"
                                        onClick={() => onKill(p)}
                                        disabled={killingPid === p.pid}
                                        className="rounded-md border border-[var(--dd-border)] px-3 py-1 text-xs font-semibold text-[var(--dd-danger)] transition-colors hover:border-[var(--dd-danger)] disabled:opacity-50"
                                    >
                                        {killingPid === p.pid ? "Killing…" : "Kill"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {ports.length === 0 ? (
                    <p className="px-2 py-4 text-[var(--dd-text-muted)]">
                        {query ? `No ports match "${query}".` : "No listening ports."}
                    </p>
                ) : null}
            </div>
        </div>
    );
}
