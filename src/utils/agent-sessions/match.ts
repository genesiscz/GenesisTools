import type { AgentSearchFilters } from "./types";

export function haystackMatch(haystack: string, query: string, filters: AgentSearchFilters): boolean {
    if (filters.regex) {
        if (!isSafeHistoryRegex(query)) {
            return false;
        }
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

/**
 * Rejects nested quantifiers, the shape that makes backtracking explode.
 *
 * A lazy modifier is NOT one: `.*?`, `+?`, `??` and `{2,}?` are a single quantifier with a
 * greediness flag, and they are the most common thing anyone types. Treating them as unsafe
 * made `--regex 'foo.*?bar'` fail with "Unsafe history regular expression", so strip one
 * trailing `?` from each quantifier before looking for a second one.
 */
export function isSafeHistoryRegex(pattern: string): boolean {
    const withoutLazyModifiers = pattern.replace(/(\+|\*|\?|\{[\d,]+\})\?/g, "$1");

    return pattern.length <= 200 && !/(\+|\*|\?|\{[\d,]+\})\s*\)?\s*(\+|\*|\?|\{[\d,]+\})/.test(withoutLazyModifiers);
}
