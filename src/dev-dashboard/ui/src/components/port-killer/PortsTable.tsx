import {
    collapseDualStack,
    filterPortsByKind,
    type PortFilterId,
    type PortSortDir,
    type PortSortKey,
    sortPorts,
    splitVisibility,
} from "@app/dev-dashboard/lib/ports/classify";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { fuzzySearchByHaystack } from "@app/utils/fuzzy-search";
import { useState } from "react";
import { PortFilters } from "@/components/ports/PortFilters";
import { PortKindBadge } from "@/components/ports/PortKindBadge";
import { SearchInput } from "@/components/SearchInput";

interface PortsTableProps {
    result: PortsResult;
    onKill: (port: PortInfo) => void;
    killingPid: number | null;
}

function portHaystack(p: PortInfo): string {
    return [p.port, p.command, p.fullCommand, p.title, p.cwd, p.pid, p.address, p.kind].filter(Boolean).join(" ");
}

function protoLabel(proto: PortInfo["proto"]): string {
    return proto === "tcp6" ? "IPv6" : "IPv4";
}

function formatAge(startedAt?: string): string {
    if (!startedAt) {
        return "—";
    }

    const ms = Date.now() - Date.parse(startedAt);
    if (!Number.isFinite(ms) || ms < 0) {
        return "—";
    }

    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    const days = Math.floor(hr / 24);

    if (days > 0) {
        return `${days}d ${hr % 24}h`;
    }

    if (hr > 0) {
        return `${hr}h ${min % 60}m`;
    }

    if (min > 0) {
        return `${min}m`;
    }

    return `${sec}s`;
}

export function PortsTable({ result, onKill, killingPid }: PortsTableProps) {
    const [query, setQuery] = useState("");
    const [filters, setFilters] = useState<PortFilterId[]>(["all"]);
    const [sortKey, setSortKey] = useState<PortSortKey>("port");
    const [sortDir, setSortDir] = useState<PortSortDir>("asc");
    const [showHidden, setShowHidden] = useState(false);

    if (!result.lsofAvailable) {
        return (
            <div className="dd-panel flex h-full items-center justify-center p-8 text-center text-[var(--dd-text-muted)]">
                lsof is not available on this host — listening ports can't be enumerated.
            </div>
        );
    }

    const { normal, hidden } = splitVisibility(collapseDualStack(result.ports));
    const filtered = sortPorts(filterPortsByKind(normal, filters), sortKey, sortDir);
    const ports = fuzzySearchByHaystack(filtered, query, portHaystack).items;
    const hiddenSorted = sortPorts(hidden, sortKey, sortDir);

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-4">
                    <h3 className="dd-accent-text text-lg font-semibold">
                        Listening ports ({ports.length}
                        {query || !filters.includes("all") ? ` / ${filtered.length}` : ""})
                    </h3>
                    <SearchInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search ports — command, path, pid…"
                        className="max-w-xs"
                    />
                </div>
                <PortFilters
                    selected={filters}
                    onChange={setFilters}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSortKey={setSortKey}
                    onSortDir={setSortDir}
                />
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-[var(--dd-text-secondary)]">
                            <th className="px-2 py-2 font-medium">Port</th>
                            <th className="px-2 py-2 font-medium">Kind</th>
                            <th className="px-2 py-2 font-medium">Name / command</th>
                            <th className="px-2 py-2 font-medium">Path</th>
                            <th className="px-2 py-2 font-medium">Age</th>
                            <th className="px-2 py-2 font-medium">PID</th>
                            <th className="px-2 py-2 font-medium">Addr</th>
                            <th className="px-2 py-2 font-medium" />
                        </tr>
                    </thead>
                    <tbody>
                        {ports.map((p) => (
                            <PortKillerRow
                                key={`${p.pid}-${p.port}-${p.proto}`}
                                p={p}
                                onKill={onKill}
                                killing={killingPid === p.pid}
                            />
                        ))}
                    </tbody>
                </table>
                {ports.length === 0 ? (
                    <p className="px-2 py-4 text-[var(--dd-text-muted)]">
                        {query ? `No ports match "${query}".` : "No listening ports."}
                    </p>
                ) : null}
            </div>

            {hiddenSorted.length > 0 ? (
                <div className="border-t border-[var(--dd-border)] pt-2">
                    <button
                        type="button"
                        onClick={() => setShowHidden((v) => !v)}
                        className="font-mono text-xs text-[var(--dd-text-muted)] hover:text-[var(--dd-text-secondary)]"
                    >
                        {showHidden ? "▾" : "▸"} {hiddenSorted.length} system / junk hidden
                    </button>
                    {showHidden ? (
                        <div className="mt-2 overflow-x-auto opacity-80">
                            <table className="w-full text-sm">
                                <tbody>
                                    {hiddenSorted.map((p) => (
                                        <PortKillerRow
                                            key={`h-${p.pid}-${p.port}-${p.proto}`}
                                            p={p}
                                            onKill={onKill}
                                            killing={killingPid === p.pid}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function PortKillerRow({ p, onKill, killing }: { p: PortInfo; onKill: (port: PortInfo) => void; killing: boolean }) {
    return (
        <tr className="border-t border-[var(--dd-border)] text-[var(--dd-text-primary)] align-top">
            <td className="px-2 py-2 font-mono font-medium text-[var(--dd-accent)]">
                :{p.port}
                <div className="font-mono text-[10px] text-[var(--dd-text-muted)]">{protoLabel(p.proto)}</div>
            </td>
            <td className="px-2 py-2">
                <PortKindBadge port={p} />
            </td>
            <td className="px-2 py-2 max-w-[40ch]">
                <div className="font-medium">{p.title ?? p.command}</div>
                <div className="font-mono text-xs text-[var(--dd-text-muted)]">{p.command}</div>
                {p.fullCommand && p.fullCommand !== p.command ? (
                    <div
                        title={p.fullCommand}
                        className="break-all font-mono text-[11px] text-[var(--dd-text-secondary)]"
                    >
                        {p.fullCommand}
                    </div>
                ) : null}
            </td>
            <td className="px-2 py-2 max-w-[36ch]">
                {p.cwd ? (
                    <div title={p.cwd} className="break-all font-mono text-xs text-[var(--dd-text-secondary)]">
                        {p.cwd}
                    </div>
                ) : (
                    <span className="text-[var(--dd-text-muted)]">—</span>
                )}
            </td>
            <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)] whitespace-nowrap">
                {formatAge(p.startedAt)}
            </td>
            <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-muted)]">{p.pid}</td>
            <td className="px-2 py-2 font-mono text-xs text-[var(--dd-text-secondary)]">{p.address}</td>
            <td className="px-2 py-2 text-right">
                <button
                    type="button"
                    onClick={() => onKill(p)}
                    disabled={killing}
                    className="rounded-md border border-[var(--dd-border)] px-3 py-1 text-xs font-semibold text-[var(--dd-danger)] transition-colors hover:border-[var(--dd-danger)] disabled:opacity-50"
                >
                    {killing ? "Killing…" : "Kill"}
                </button>
            </td>
        </tr>
    );
}
