import type { TmuxSessionInfo } from "@app/utils/tmux/types";

export interface TmuxHubSession extends TmuxSessionInfo {
    ttydTabIds: string[];
    canAttachInTtyd: boolean;
}

interface TtydBinding {
    id: string;
    tmuxSessionName?: string;
}

export function enrichSessionsForHub(sessions: TmuxSessionInfo[], ttydSessions: TtydBinding[]): TmuxHubSession[] {
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

        return {
            ...session,
            ttydTabIds,
            canAttachInTtyd: ttydTabIds.length === 0,
        };
    });
}
