import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { useNowTick } from "@app/utils/ui/hooks/useNowTick";
import type { ReactElement } from "react";
import { resolveSessionLiveStatusDisplay } from "./session-live-status";

interface Props {
    session: DashboardSession;
    latestLineTs?: number;
    className?: string;
}

function phaseToneClass(phase: ReturnType<typeof resolveSessionLiveStatusDisplay>["phase"]): string {
    if (phase === "running") {
        return "text-emerald-400/90";
    }

    if (phase === "killed") {
        return "text-rose-400/85";
    }

    if (phase === "exited") {
        return "text-white/45";
    }

    return "text-amber-400/80";
}

export function SessionLiveStatus({ session, latestLineTs, className = "" }: Props): ReactElement {
    const now = useNowTick(1000);
    const display = resolveSessionLiveStatusDisplay({
        session,
        latestLineTs,
        now,
    });

    if (display.phase === "fallback") {
        return <span className={`${phaseToneClass(display.phase)} ${className}`.trim()}>{display.stateLabel}</span>;
    }

    if (display.phase === "running") {
        return (
            <span className={`inline-flex items-baseline flex-wrap ${className}`.trim()}>
                <span className={phaseToneClass(display.phase)}>{display.stateLabel}</span>
                <span className="text-white/35">
                    {" · last message "}
                    <span className={`ui-recency ui-recency--${display.recencyTier ?? "muted"}`}>
                        {display.agoLabel}
                    </span>
                </span>
            </span>
        );
    }

    return (
        <span className={`inline-flex items-baseline flex-wrap gap-x-1 ${className}`.trim()}>
            <span className={phaseToneClass(display.phase)}>{display.stateLabel}</span>
            <span className="text-white/35">
                <span className="text-white/25">·</span>{" "}
                <span className={`ui-recency ui-recency--${display.recencyTier ?? "muted"}`}>{display.agoLabel}</span>
            </span>
        </span>
    );
}
