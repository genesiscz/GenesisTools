import type { TmuxSessionInfo } from "@app/utils/tmux/types";
import type { CmuxTmuxSurfaceRef } from "@app/utils/cmux/tmux-bindings";

export interface TmuxHubSession extends TmuxSessionInfo {
    ttydTabIds: string[];
    canAttachInTtyd: boolean;
    cmuxSurfaces: CmuxTmuxSurfaceRef[];
    inCmux: boolean;
}

interface TtydBinding {
    id: string;
    tmuxSessionName?: string;
}

export function enrichSessionsForHub(
    sessions: TmuxSessionInfo[],
    ttydSessions: TtydBinding[],
    cmuxBySession: Map<string, CmuxTmuxSurfaceRef[]> = new Map()
): TmuxHubSession[] {
    const ttydByTmux = new Map<string, string[]>();

    for (const ttyd of ttydSessions) {
        if (!ttyd.tmuxSessionName) {
            continue;
        }

        const existing = ttydByTmux.get(ttyd.tmuxSessionName) ?? [];
        existing.push(ttyd.id);
        ttydByTmux.set(ttyd.tmuxSessionName, existing);
    }

    return sessions.map((session) => {
        const ttydTabIds = ttydByTmux.get(session.name) ?? [];
        const cmuxSurfaces = cmuxBySession.get(session.name) ?? [];

        return {
            ...session,
            ttydTabIds,
            canAttachInTtyd: ttydTabIds.length === 0,
            cmuxSurfaces,
            inCmux: cmuxSurfaces.length > 0,
        };
    });
}
