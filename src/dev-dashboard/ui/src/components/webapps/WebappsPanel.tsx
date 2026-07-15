import {
    type PortFilterId,
    type PortSortDir,
    type PortSortKey,
    sortPorts,
    splitVisibility,
} from "@app/dev-dashboard/lib/ports/classify";
import type { PortInfo } from "@app/dev-dashboard/lib/ports/types";
import { selectPortsForPanel } from "@app/dev-dashboard/lib/ports/webapps";
import { fuzzySearchByHaystack } from "@app/utils/fuzzy-search";
import { useMemo, useState } from "react";
import { PortFilters } from "@/components/ports/PortFilters";
import { PortKindBadge } from "@/components/ports/PortKindBadge";
import { SearchInput } from "@/components/SearchInput";
import { usePorts } from "@/hooks/usePorts";

function portHaystack(p: PortInfo): string {
    return [p.port, p.title, p.command, p.fullCommand, p.cwd, p.pid, p.kind].filter(Boolean).join(" ");
}

function formatAge(startedAt?: string): string {
    if (!startedAt) {
        return "";
    }

    const ms = Date.now() - Date.parse(startedAt);
    if (!Number.isFinite(ms) || ms < 0) {
        return "";
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

export function WebappsPanel({ enableLive = true }: { enableLive?: boolean } = {}) {
    const [query, setQuery] = useState("");
    const [filters, setFilters] = useState<PortFilterId[]>(["all"]);
    const [sortKey, setSortKey] = useState<PortSortKey>("age");
    const [sortDir, setSortDir] = useState<PortSortDir>("asc");
    const [showHidden, setShowHidden] = useState(false);

    const { data } = usePorts({ enableLive });

    const { normal } = useMemo(() => {
        if (!data?.ports) {
            return { normal: [] as PortInfo[] };
        }

        return splitVisibility(data.ports);
    }, [data?.ports]);

    const filtered = useMemo(() => {
        const selected = selectPortsForPanel(normal, { filters });
        return sortPorts(selected, sortKey, sortDir);
    }, [normal, filters, sortKey, sortDir]);

    const visible = fuzzySearchByHaystack(filtered, query, portHaystack).items;

    const hiddenSorted = useMemo(() => sortPorts(splitVisibility(data?.ports ?? []).hidden, sortKey, sortDir), [
        data?.ports,
        sortKey,
        sortDir,
    ]);

    const pendingCount = normal.filter((p) => p.probeStatus === "pending").length;

    return (
        <div className="dd-panel flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                    <h3 className="dd-accent-text text-sm font-bold tracking-widest">
                        PORTS ({visible.length}
                        {query || !filters.includes("all") ? ` / ${filtered.length}` : ""})
                        {pendingCount > 0 ? (
                            <span className="ml-2 font-mono text-[10px] font-normal tracking-normal text-[var(--dd-text-muted)]">
                                classifying {pendingCount}…
                            </span>
                        ) : null}
                    </h3>
                </div>
                <PortFilters
                    selected={filters}
                    onChange={setFilters}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSortKey={setSortKey}
                    onSortDir={setSortDir}
                />
                {filtered.length > 0 || query ? (
                    <SearchInput value={query} onChange={setQuery} placeholder="Filter ports…" />
                ) : null}
            </div>

            {visible.length === 0 ? (
                <p className="font-mono text-sm text-[var(--dd-text-muted)]">
                    {!data ? "Scanning…" : query ? `No ports match "${query}".` : "No matching listeners."}
                </p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {visible.map((app) => (
                        <PortRow key={`${app.pid}-${app.port}`} app={app} />
                    ))}
                </ul>
            )}

            {hiddenSorted.length > 0 ? (
                <div className="border-t border-[var(--dd-border)] pt-2">
                    <button
                        type="button"
                        onClick={() => setShowHidden((v) => !v)}
                        className="w-full text-left font-mono text-xs text-[var(--dd-text-muted)] hover:text-[var(--dd-text-secondary)]"
                    >
                        {showHidden ? "▾" : "▸"} {hiddenSorted.length} system / junk hidden
                    </button>
                    {showHidden ? (
                        <ul className="mt-2 flex flex-col gap-2 opacity-80">
                            {hiddenSorted.map((app) => (
                                <PortRow key={`h-${app.pid}-${app.port}`} app={app} />
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function PortRow({ app }: { app: PortInfo }) {
    const age = formatAge(app.startedAt);
    const isHttp = app.kind === "web" || app.kind === "api" || app.kind === "genesis-tools" || app.isWebapp;

    return (
        <li className="border-t border-[var(--dd-border)] pt-2 first:border-t-0 first:pt-0">
            <div className="min-w-0 flex flex-col gap-0.5">
                {isHttp ? (
                    <a
                        href={`http://localhost:${app.port}/`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-sm font-semibold text-[var(--dd-accent)] hover:underline"
                    >
                        {app.title ?? app.command}
                        <span className="ml-1 font-mono text-xs text-[var(--dd-text-muted)]">:{app.port}</span>
                    </a>
                ) : (
                    <span className="truncate text-sm font-semibold text-[var(--dd-text-primary)]">
                        {app.title ?? app.command}
                        <span className="ml-1 font-mono text-xs text-[var(--dd-text-muted)]">:{app.port}</span>
                    </span>
                )}
                {app.cwd ? (
                    <span title={app.cwd} className="truncate font-mono text-xs text-[var(--dd-text-secondary)]">
                        {app.cwd}
                    </span>
                ) : app.fullCommand ? (
                    <span
                        title={app.fullCommand}
                        className="truncate font-mono text-xs text-[var(--dd-text-secondary)]"
                    >
                        {app.fullCommand}
                    </span>
                ) : null}
                <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex min-w-[3.5rem] shrink-0">
                        <PortKindBadge port={app} />
                    </span>
                    <span className="truncate font-mono text-xs text-[var(--dd-text-muted)]">
                        {app.command} · {app.pid}
                        {age ? ` · ${age}` : ""}
                    </span>
                </div>
            </div>
        </li>
    );
}
