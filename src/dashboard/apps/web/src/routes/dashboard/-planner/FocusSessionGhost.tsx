/**
 * FocusSessionGhost — renders a translucent block representing a completed
 * pomodoro focus session on the day timeline.
 *
 * Data source: activity_log rows with eventType = "pomodoro_phase_change" where
 * metadata.fromPhase === "work" (a work session completed).
 * Provided by aggregateFocusSessions server fn via usePlannerData.
 */

export interface FocusSession {
    timerId: string;
    startIso: string;
    endIso: string;
}

interface FocusSessionGhostProps {
    session: FocusSession;
    topPx: number;
    heightPx: number;
}

export function FocusSessionGhost({ topPx, heightPx }: FocusSessionGhostProps) {
    return (
        <div
            className="pointer-events-none absolute inset-x-1 rounded border border-dashed border-violet-500/40 bg-violet-900/20"
            style={{ top: `${topPx}px`, height: `${heightPx}px` }}
        >
            <span className="block truncate px-1 pt-0.5 text-[9px] text-violet-400/70">focus</span>
        </div>
    );
}
