import type { ReactElement, ReactNode } from "react";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { useSessionDeleteConfirm } from "@/lib/ui/SessionDeleteConfirm";
import { SessionHeaderLine } from "./SessionHeaderLine";
import { SessionLiveStatus } from "@/lib/ui/SessionLiveStatus";

interface Props {
    session: DashboardSession;
    latestLineTs?: number;
    onNameClick?: () => void;
    showCommand?: boolean;
    trailing?: ReactNode;
    className?: string;
}

export function SessionRowBar({
    session,
    latestLineTs,
    onNameClick,
    showCommand = false,
    trailing,
    className = "",
}: Props): ReactElement {
    return (
        <div className={`dbg-session-row ${className}`.trim()}>
            <SessionHeaderLine
                session={session}
                onNameClick={onNameClick}
                className="dbg-session-row__identity min-w-0"
                layout="inline"
                showCommand={showCommand}
            />
            <div className="dbg-session-row__meta">
                <SessionLiveStatus
                    session={session}
                    latestLineTs={latestLineTs}
                    className="dbg-ui-text-sm whitespace-nowrap"
                />
                {trailing ? <div className="dbg-session-row__actions">{trailing}</div> : null}
            </div>
        </div>
    );
}

interface SessionDeleteButtonProps {
    session: DashboardSession;
    onConfirmed?: () => void;
    onAfterDelete?: () => void;
}

export function SessionDeleteButton({ session, onConfirmed, onAfterDelete }: SessionDeleteButtonProps): ReactElement {
    const { requestDelete } = useSessionDeleteConfirm();

    return (
        <button
            type="button"
            onClick={() => {
                requestDelete({
                    source: session.source,
                    name: session.name,
                    badge: session.badge,
                    onConfirmed,
                    onAfterDelete,
                });
            }}
            className="dbg-ui-btn uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-2 py-1 border border-rose-500/20 hover:border-rose-500/60 rounded-md transition-colors hover:-translate-y-px"
        >
            delete
        </button>
    );
}
