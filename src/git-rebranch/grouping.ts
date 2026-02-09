import type { DetailedCommitInfo } from "@app/utils/git";
import type { ParsedCommit, CommitGroup } from "./types";

/** Conventional commit regex: type(scope)!: message */
const CONVENTIONAL_RE = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;

/** Ticket pattern: matches PROJ-123, COL-456, etc. */
const TICKET_RE = /[A-Z]{2,10}-\d+/g;

/**
 * Extract ticket numbers from scope and/or body
 */
function extractTickets(scope: string | null, body: string): string[] {
    const combined = [scope, body].filter(Boolean).join(" ");
    const matches = combined.match(TICKET_RE) || [];
    return [...new Set(matches)];
}

/**
 * Build a normalized group key from scope and tickets.
 * Priority: tickets first, then scope words.
 */
function buildGroupKey(scope: string | null, tickets: string[]): string {
    if (tickets.length > 0) {
        const scopeWithoutTickets = scope
            ? scope
                  .replace(TICKET_RE, "")
                  .replace(/[,\s]+/g, " ")
                  .trim()
            : "";
        const ticketKey = tickets.sort().join(",").toLowerCase();
        return scopeWithoutTickets ? `${scopeWithoutTickets}:${ticketKey}` : ticketKey;
    }

    if (scope) {
        return scope
            .toLowerCase()
            .replace(/[,\s]+/g, " ")
            .trim();
    }

    return "ungrouped";
}

/**
 * Build a human-readable label for a group.
 */
function buildGroupLabel(key: string, _commits: ParsedCommit[]): string {
    if (key === "ungrouped") return "Ungrouped commits";

    const tickets = key.match(TICKET_RE) || [];
    const scopePart = key
        .replace(TICKET_RE, "")
        .replace(/[:, ]+/g, " ")
        .trim();

    const parts: string[] = [];
    if (scopePart) parts.push(scopePart);
    if (tickets.length > 0) parts.push(tickets.join(", "));

    return parts.join(" - ") || key;
}

/**
 * Parse a single commit message into structured form
 */
export function parseCommit(commit: DetailedCommitInfo): ParsedCommit {
    const match = commit.message.match(CONVENTIONAL_RE);

    if (match) {
        const type = match[1];
        const scope = match[3] || null;
        const body = match[5];
        const tickets = extractTickets(scope, body);
        const groupKey = buildGroupKey(scope, tickets);

        return { commit, type, scope, tickets, body, groupKey };
    }

    // Non-conventional commit: try to extract tickets from message
    const tickets = extractTickets(null, commit.message);
    const groupKey = tickets.length > 0 ? tickets.sort().join(",").toLowerCase() : "ungrouped";

    return {
        commit,
        type: null,
        scope: null,
        tickets,
        body: commit.message,
        groupKey,
    };
}

/**
 * Group parsed commits by their group key.
 * Returns groups sorted by number of commits (largest first),
 * with "ungrouped" always last.
 */
export function groupCommits(parsed: ParsedCommit[]): CommitGroup[] {
    const groupMap = new Map<string, ParsedCommit[]>();

    for (const p of parsed) {
        const existing = groupMap.get(p.groupKey) || [];
        existing.push(p);
        groupMap.set(p.groupKey, existing);
    }

    const groups: CommitGroup[] = [];
    for (const [key, commits] of groupMap) {
        const label = buildGroupLabel(key, commits);
        groups.push({ key, label, commits });
    }

    return groups.sort((a, b) => {
        if (a.key === "ungrouped") return 1;
        if (b.key === "ungrouped") return -1;
        return b.commits.length - a.commits.length;
    });
}
