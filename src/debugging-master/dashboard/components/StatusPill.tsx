import type { ConnectionStatus } from "@/lib/sse";

const LABELS: Record<ConnectionStatus, string> = {
    connecting: "connecting",
    live: "connected",
    reconnecting: "offline · retrying",
    down: "offline",
};

const DOT_CLASS: Record<ConnectionStatus, string> = {
    connecting: "status-dot status-warn",
    live: "status-dot status-live",
    reconnecting: "status-dot status-warn",
    down: "status-dot status-down",
};

interface Props {
    status: ConnectionStatus;
    refreshing?: boolean;
}

export function StatusPill({ status, refreshing = false }: Props): React.ReactElement {
    let label = LABELS[status];

    if (refreshing && status === "live") {
        label = "connected · refreshing";
    }

    return (
        <span className="dbg-ui-text-sm inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/8 bg-white/[0.02] uppercase tracking-wider">
            <span className={DOT_CLASS[status]} />
            <span className="text-white/70">{label}</span>
        </span>
    );
}
