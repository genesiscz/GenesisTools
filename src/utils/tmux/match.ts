import type { TmuxSessionInfo } from "@app/utils/tmux/types";

export type SessionMatch =
    | { kind: "exact"; name: string }
    | { kind: "single"; name: string }
    | { kind: "ambiguous"; matches: string[] }
    | { kind: "none" };

/**
 * Resolve a free-text query to a tmux session. An exact name match always wins;
 * otherwise substring match: 0 → none, 1 → single, >1 → ambiguous. Pure (the query
 * is trimmed first) so callers can unit-test resolution without a live tmux server.
 */
export function resolveSessionQuery(query: string, sessions: TmuxSessionInfo[]): SessionMatch {
    const trimmed = query.trim();

    if (sessions.some((s) => s.name === trimmed)) {
        return { kind: "exact", name: trimmed };
    }

    const matches = sessions.filter((s) => s.name.includes(trimmed)).map((s) => s.name);

    if (matches.length === 0) {
        return { kind: "none" };
    }

    if (matches.length === 1 && matches[0]) {
        return { kind: "single", name: matches[0] };
    }

    return { kind: "ambiguous", matches };
}
