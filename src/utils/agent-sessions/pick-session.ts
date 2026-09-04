import type { AgentSession } from "./types";

/**
 * Resolve a resume query against a session list. Unique id prefix wins, then a
 * unique title substring. Ambiguous or empty returns undefined so the CLI can
 * prompt or list.
 */
export function pickSessionByQuery(sessions: AgentSession[], query: string | undefined): AgentSession | undefined {
    if (!query?.trim()) {
        return undefined;
    }

    const q = query.trim().toLowerCase();
    const byId = sessions.filter(
        (session) => session.sessionId.toLowerCase() === q || session.sessionId.toLowerCase().startsWith(q)
    );
    if (byId.length === 1) {
        return byId[0];
    }

    const byTitle = sessions.filter((session) => session.title.toLowerCase().includes(q));
    if (byTitle.length === 1) {
        return byTitle[0];
    }

    return undefined;
}
