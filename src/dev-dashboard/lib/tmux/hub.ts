import { ttydLabel } from "@app/dev-dashboard/lib/ttyd/label";
import type { CmuxTmuxSurfaceRef } from "@genesiscz/utils/cmux/tmux-bindings";
import type { TmuxSessionInfo } from "@genesiscz/utils/tmux/types";

export interface TtydHubTab {
    id: string;
    port: number;
    label: string;
    cwd?: string;
    lastCommand?: string;
}

export interface TmuxHubSession extends TmuxSessionInfo {
    ttydTabIds: string[];
    ttydTabs: TtydHubTab[];
    canAttachInTtyd: boolean;
    cmuxSurfaces: CmuxTmuxSurfaceRef[];
    inCmux: boolean;
}

interface TtydBinding {
    id: string;
    port: number;
    command: string;
    cwd: string;
    tmuxSessionName?: string;
    name?: string;
    lastCommand?: string;
}

export function enrichSessionsForHub(
    sessions: TmuxSessionInfo[],
    ttydSessions: TtydBinding[],
    cmuxBySession: Map<string, CmuxTmuxSurfaceRef[]> = new Map()
): TmuxHubSession[] {
    const ttydByTmux = new Map<string, TtydHubTab[]>();

    for (const ttyd of ttydSessions) {
        if (!ttyd.tmuxSessionName) {
            continue;
        }

        const tab: TtydHubTab = {
            id: ttyd.id,
            port: ttyd.port,
            label: ttydLabel(ttyd),
            cwd: ttyd.cwd,
            lastCommand: ttyd.lastCommand,
        };
        const existing = ttydByTmux.get(ttyd.tmuxSessionName) ?? [];
        existing.push(tab);
        ttydByTmux.set(ttyd.tmuxSessionName, existing);
    }

    return sessions.map((session) => {
        const ttydTabs = ttydByTmux.get(session.name) ?? [];
        const cmuxSurfaces = cmuxBySession.get(session.name) ?? [];

        return {
            ...session,
            ttydTabIds: ttydTabs.map((tab) => tab.id),
            ttydTabs,
            canAttachInTtyd: ttydTabs.length === 0,
            cmuxSurfaces,
            inCmux: cmuxSurfaces.length > 0,
        };
    });
}
