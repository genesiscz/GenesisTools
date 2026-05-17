import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

interface Props {
    session: TtydSession;
}

export function TtydPane({ session }: Props) {
    return (
        <div className="dd-panel flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--dd-border)] px-2 py-1 text-[10px] text-[var(--dd-text-secondary)]">
                <span className="font-mono">ttyd · {session.command}</span>
                <span className="font-mono text-[var(--dd-text-muted)]">:{session.port}</span>
            </div>
            <iframe
                src={`/ttyd/${encodeURIComponent(session.id)}/`}
                title={`ttyd-${session.id}`}
                className="flex-1 border-0 bg-black"
            />
        </div>
    );
}
