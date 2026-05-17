import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import type { TtydSession } from "@app/dev-dashboard/lib/ttyd/types";

export interface TermTab {
    id: string;
    label: string;
    active: boolean;
}

export function buildTtydTabs(sessions: TtydSession[], activeId: string | null): TermTab[] {
    return sessions.map((session) => ({
        id: session.id,
        label: ttydLabel(session),
        active: session.id === activeId,
    }));
}
