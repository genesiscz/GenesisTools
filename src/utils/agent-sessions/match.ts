import type { AgentSearchFilters, AgentSearchHit, AgentSession } from "./types";

export function sessionMatchesTime(session: AgentSession, filters: AgentSearchFilters): boolean {
    if (filters.since && session.mtime < filters.since) {
        return false;
    }

    if (filters.until && session.mtime > filters.until) {
        return false;
    }

    return true;
}

export function sessionMatchesCwd(session: AgentSession, filters: AgentSearchFilters): boolean {
    if (filters.all) {
        return true;
    }

    if (filters.cwd && session.cwd !== filters.cwd) {
        return false;
    }

    if (filters.project) {
        // `--project GenesisTools` used to land in `filters.cwd` and be compared
        // against the absolute cwd, so it matched nothing, ever. The leaf name
        // is its own field; not every adapter fills it, so derive it when absent.
        const leaf = session.project ?? session.cwd.split("/").filter(Boolean).pop();

        if (leaf !== filters.project) {
            return false;
        }
    }

    return true;
}

export function haystackMatch(haystack: string, query: string, filters: AgentSearchFilters): boolean {
    if (filters.regex) {
        try {
            return new RegExp(query, "i").test(haystack);
        } catch {
            return false;
        }
    }

    const hay = haystack.toLowerCase();
    const needle = query.toLowerCase();

    if (filters.exact) {
        return hay.includes(needle);
    }

    const words = needle.split(/\s+/).filter(Boolean);
    return words.every((word) => hay.includes(word));
}

export function matchSessionText(
    session: AgentSession,
    extraTexts: string[],
    filters: AgentSearchFilters
): AgentSearchHit | undefined {
    if (!sessionMatchesCwd(session, filters) || !sessionMatchesTime(session, filters)) {
        return undefined;
    }

    const query = filters.query?.trim();
    if (!query) {
        return session;
    }

    const fields = [session.sessionId, session.title, session.summary ?? "", session.prompt ?? "", ...extraTexts];
    for (const field of fields) {
        if (field && haystackMatch(field, query, filters)) {
            return { ...session, matchedText: field.slice(0, 240) };
        }
    }

    return undefined;
}

export function sortAndLimit(hits: AgentSearchHit[], limit?: number): AgentSearchHit[] {
    hits.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    if (limit !== undefined && limit >= 0) {
        return hits.slice(0, limit);
    }

    return hits;
}
