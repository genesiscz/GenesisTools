/**
 * Shared string utilities for CLI tools.
 * Consolidates slugify, stripAnsi, escapeShellArg, removeDiacritics,
 * truncateText, and sanitizeOutput from across the codebase.
 */

/**
 * Create a URL-safe slug from a title string.
 * Normalizes diacritics, replaces non-alphanumeric with dashes, trims, and limits to 50 chars.
 */
export function slugify(title: string): string {
    return title
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
}

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsi(input: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code matching
    return input.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Escape a string for safe use as a shell argument (single-quoted).
 */
export function escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Remove diacritical marks from a string using Unicode NFD normalization.
 * Handles all Unicode combining marks, not just specific languages.
 */
export function removeDiacritics(str: string): string {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
export function truncateText(text: string, maxLength: number = 100): string {
    if (text.length <= maxLength) {
        return text;
    }
    if (maxLength <= 3) {
        return text.substring(0, maxLength);
    }
    return `${text.substring(0, maxLength - 3)}...`;
}

/**
 * Remove control characters from text. Optionally strip ANSI escape codes.
 */
export function sanitizeOutput(text: string, removeANSI: boolean = false): string {
    let sanitized = text;
    if (removeANSI) {
        sanitized = stripAnsi(sanitized);
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character stripping for sanitization
    sanitized = sanitized.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    return sanitized;
}

/**
 * Simple glob matching: `*` matches any sequence of characters.
 * Case-insensitive. Escapes regex special chars except `*`.
 */
export function matchGlob(value: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Simple fuzzy match: checks if all characters of `query` appear
 * in `target` in order (case-insensitive). Returns match score
 * (lower = better, -1 = no match).
 */
export function fuzzyMatch(query: string, target: string): number {
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    if (t === q) {
        return 0;
    }
    if (t.startsWith(q)) {
        return 1;
    }
    if (t.includes(q)) {
        return 2;
    }

    let qi = 0;
    let gaps = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            qi++;
        } else if (qi > 0) {
            gaps++;
        }
    }
    if (qi < q.length) {
        return -1;
    }
    return 3 + gaps;
}

/**
 * Find the best fuzzy match from a list of candidates.
 * Returns null if no match found.
 */
export function fuzzyFind(query: string, candidates: string[]): string | null {
    let bestScore = Infinity;
    let bestMatch: string | null = null;
    for (const c of candidates) {
        const score = fuzzyMatch(query, c);
        if (score >= 0 && score < bestScore) {
            bestScore = score;
            bestMatch = c;
        }
    }
    return bestMatch;
}
