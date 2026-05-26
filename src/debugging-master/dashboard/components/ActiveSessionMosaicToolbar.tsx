import type { ReactElement } from "react";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import type { MultiplexLogEntry } from "@/lib/sse";
import { AutoscrollToggle } from "./AutoscrollToggle";
import { SessionHeaderLine } from "./SessionHeaderLine";
import { SessionStatusLabel } from "./SessionStatusLabel";

interface Props {
    session: DashboardSession;
    lines: MultiplexLogEntry[];
    paused: boolean;
    onTogglePause: () => void;
    onOpen: () => void;
    onDelete: () => void;
}

function stateClass(state: DashboardSession["state"]): string {
    if (state === "active") {
        return "text-emerald-400/90";
    }

    if (state === "exited") {
        return "text-white/45";
    }

    return "text-amber-400/80";
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
    onDelete,
}: Props): ReactElement {
    return (
        <div className="flex w-full items-center gap-2 min-w-0 py-0.5">
            <SessionHeaderLine session={session} onNameClick={onOpen} className="flex-1" />
            <div className="flex items-center gap-1 shrink-0">
                <span className={`text-[10px] ${stateClass(session.state)}`}>
                    <SessionStatusLabel session={session} latestLineTs={latestLineTimestamp(lines)} />
                </span>
                <AutoscrollToggle paused={paused} onToggle={onTogglePause} />
                <button
                    type="button"
                    onClick={onDelete}
                    className="text-[9px] uppercase tracking-wider text-rose-400/70 hover:text-rose-300 px-1 py-0.5 border border-rose-500/20 hover:border-rose-500/60 rounded"
                >
                    delete
                </button>
            </div>
        </div>
    );
}
