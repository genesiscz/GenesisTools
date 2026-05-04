import type { ConnectionStatus } from "@/lib/sse";

const LABELS: Record<ConnectionStatus, string> = {
    connecting: "connecting",
    live: "live",
    reconnecting: "reconnecting",
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
    subscribers?: number;
}

export function StatusPill({ status }: Props): React.ReactElement {
    return (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/8 bg-white/[0.02] text-[10px] uppercase tracking-wider">
            <span className={DOT_CLASS[status]} />
            <span className="text-white/70">{LABELS[status]}</span>
        </span>
    );
}
