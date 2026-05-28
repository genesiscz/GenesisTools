import type { ReactElement } from "react";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import type { MultiplexLogEntry } from "@/lib/sse";
import { AutoscrollToggle } from "./AutoscrollToggle";
import { SessionDeleteButton, SessionRowBar } from "./SessionRowBar";

interface Props {
    session: DashboardSession;
    lines: MultiplexLogEntry[];
    paused: boolean;
    onTogglePause: () => void;
    onOpen: () => void;
    onDeleteConfirmed?: () => void;
}

function latestLineTimestamp(lines: MultiplexLogEntry[]): number | undefined {
    if (lines.length === 0) {
        return undefined;
    }

    return lines[lines.length - 1].ts;
}

export function ActiveSessionMosaicToolbar({
    session,
    lines,
    paused,
    onTogglePause,
    onOpen,
    onDeleteConfirmed,
}: Props): ReactElement {
    const isLive = session.state === "active";

    return (
        <SessionRowBar
            session={session}
            latestLineTs={latestLineTimestamp(lines)}
            onNameClick={onOpen}
            className="dbg-session-toolbar dbg-ui-text w-full"
            trailing={
                <>
                    {isLive ? <AutoscrollToggle paused={paused} onToggle={onTogglePause} /> : null}
                    <SessionDeleteButton session={session} onConfirmed={onDeleteConfirmed} />
                </>
            }
        />
    );
}
