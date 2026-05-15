interface TopProcess {
    pid: number;
    name: string;
    rssBytes: number;
}

interface ProcessTableProps {
    processes: TopProcess[];
}

export function ProcessTable({ processes }: ProcessTableProps) {
    return (
        <div className="dd-panel p-4">
            <h3 className="dd-accent-text mb-3 text-sm font-bold tracking-widest">TOP RAM</h3>
            {processes.length === 0 ? (
                <p className="font-mono text-sm" style={{ color: "var(--dd-text-muted)" }}>
                    —
                </p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {processes.map((p) => (
                        <li
                            key={p.pid}
                            className="flex items-center justify-between font-mono text-sm"
                        >
                            <span
                                className="truncate pr-2"
                                style={{ color: "var(--dd-text-secondary)" }}
                            >
                                {p.name}
                            </span>
                            <span style={{ color: "var(--dd-text-primary)" }}>
                                {(p.rssBytes / 1024 / 1024).toFixed(0)} MB
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
