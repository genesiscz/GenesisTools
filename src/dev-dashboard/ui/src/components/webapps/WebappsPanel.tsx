import type { PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { selectWebapps } from "@app/dev-dashboard/lib/ports/webapps";
import { useQuery } from "@tanstack/react-query";
import { portsApi } from "@/lib/api";

export function WebappsPanel() {
    const { data } = useQuery<PortsResult>({
        queryKey: ["ports"],
        queryFn: () => portsApi.list(),
        refetchInterval: 8000,
    });

    const webapps = data ? selectWebapps(data.ports) : [];

    return (
        <div className="dd-panel flex flex-col gap-3 p-4">
            <h3 className="dd-accent-text text-sm font-bold tracking-widest">WEBAPPS ({webapps.length})</h3>
            {webapps.length === 0 ? (
                <p className="font-mono text-sm text-[var(--dd-text-muted)]">
                    {data ? "No local web servers listening." : "Scanning…"}
                </p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {webapps.map((app) => (
                        <li
                            key={`${app.pid}-${app.port}`}
                            className="flex items-center justify-between gap-3 border-t border-[var(--dd-border)] pt-2 first:border-t-0 first:pt-0"
                        >
                            <div className="min-w-0 flex flex-col">
                                <a
                                    href={`http://localhost:${app.port}/`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="truncate text-sm font-semibold text-[var(--dd-accent)] hover:underline"
                                >
                                    {app.title ?? app.command}
                                    <span className="ml-1 font-mono text-xs text-[var(--dd-text-muted)]">
                                        :{app.port}
                                    </span>
                                </a>
                                {app.cwd ? (
                                    <span
                                        title={app.cwd}
                                        className="truncate font-mono text-xs text-[var(--dd-text-secondary)]"
                                    >
                                        {app.cwd}
                                    </span>
                                ) : null}
                            </div>
                            <span className="shrink-0 font-mono text-xs text-[var(--dd-text-muted)]">
                                {app.command} · {app.pid}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
