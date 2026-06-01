import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import type { ReactElement } from "react";
import type { MultiplexLogEntry } from "@/lib/sse";
import { AutoscrollToggle } from "./AutoscrollToggle";
import { LogSearchControl } from "./LogSearchControl";
import type { LogSearchState } from "./LogSearchPopover";
import { SessionDeleteButton, SessionRowBar } from "./SessionRowBar";

interface Props {
    session: DashboardSession;
    lines: MultiplexLogEntry[];
    logSearch: LogSearchState;
    onLogSearchChange: (next: LogSearchState) => void;
    logMatchCount: number;
    logLineCount: number;
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
    logSearch,
    onLogSearchChange,
    logMatchCount,
    logLineCount,
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
                    <LogSearchControl
                        logSearch={logSearch}
                        onLogSearchChange={onLogSearchChange}
                        matchCount={logMatchCount}
                        lineCount={logLineCount}
                    />
                    {isLive ? <AutoscrollToggle paused={paused} onToggle={onTogglePause} /> : null}
                    <SessionDeleteButton session={session} onConfirmed={onDeleteConfirmed} />
                </>
            }
        />
    );
}
