interface Props {
    status: { installed: boolean; running: boolean; pid: number | null };
}

export function DaemonHeader({ status }: Props) {
    let label: string;
    let color: string;
    if (status.running) {
        label = `Running (PID ${status.pid ?? "?"})`;
        color = "var(--dd-accent-from)";
    } else if (status.installed) {
        label = "Installed, not running";
        color = "#fbbf24";
    } else {
        label = "Not installed";
        color = "var(--dd-text-muted)";
    }

    return (
        <div className="dd-panel flex items-center justify-between p-4">
            <h1 className="dd-accent-text text-lg font-semibold">Daemon</h1>
            <div className="flex items-center gap-2 text-sm">
                <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: color }}
                />
                <span style={{ color }}>{label}</span>
            </div>
        </div>
    );
}
