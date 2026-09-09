import { isSafeHistoryRegex } from "./match";
import type { AgentSearchFilters } from "./types";

export function validateHistoryFilters(filters: AgentSearchFilters): void {
    if (filters.regex && filters.query) {
        if (!isSafeHistoryRegex(filters.query)) {
            throw new Error("Unsafe history regular expression");
        }
        try {
            new RegExp(filters.query, "i");
        } catch {
            throw new Error("Invalid history regular expression");
        }
    }
    if (filters.exact && filters.regex) {
        throw new Error("Choose --exact or --regex, not both");
    }
    if (filters.agentsOnly && filters.excludeAgents) {
        throw new Error("Choose --agents-only or --exclude-agents, not both");
    }
}

export function matchHistoryFilePattern(content: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return isSafeHistoryRegex(escaped) && new RegExp(escaped, "i").test(content);
}
