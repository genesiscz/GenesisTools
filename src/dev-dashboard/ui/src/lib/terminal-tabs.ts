import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

export interface TermTab {
    id: string;
    /** Identity: the session name. Never Claude's topic. */
    label: string;
    active: boolean;
    /** Claude's live topic, rendered as secondary meta beside the label. */
    lastLine?: string;
}

export function buildTtydTabs(sessions: TtydSession[], activeId: string | null): TermTab[] {
    return sessions.map((session) => ({
        id: session.id,
        label: ttydLabel(session),
        active: session.id === activeId,
        lastLine: session.title,
    }));
}
