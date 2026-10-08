/**
 * Shared string utilities for CLI tools.
 * Consolidates slugify, stripAnsi, escapeShellArg, escapeHtml, removeDiacritics,
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
    const csi = /\u001b\[[?]?[0-9;]*[@-~]/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code matching
    const osc = /\u001b\].*?\u0007/g;
    return input.replace(csi, "").replace(osc, "");
}

/**
 * Escape a string for safe use as a shell argument.
 * Unix: single-quoting with escaped inner quotes.
 * Windows: two-phase escaping modeled after cross-spawn (the npm standard):
 *   Phase 1 — CommandLineToArgvW: double backslashes before quotes + trailing
 *   Phase 2 — cmd.exe metacharacters: prefix with ^ to neutralize
 *
 * For untrusted input on Windows, prefer spawn() with an argument array
 * and shell: false — cmd.exe escaping cannot be made 100% safe.
 */
// cmd.exe metacharacters that must be ^-escaped (from cross-spawn)
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function escapeShellArg(arg: string): string {
    if (process.platform === "win32") {
        // Phase 1: CommandLineToArgvW escaping (ReDoS-safe regexes from cross-spawn v7.0.5+)
        let escaped = arg
            .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"') // double backslashes before ", escape "
            .replace(/(?=(\\+?)?)\1$/, "$1$1"); // double trailing backslashes

        escaped = `"${escaped}"`;

        // Phase 2: escape cmd.exe metacharacters with ^ (including % ! & | < > etc.)
        return escaped.replace(CMD_META_CHARS, "^$1");
    }

    return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/**
 * Escape the five HTML-significant characters (& < > " ') so a string is safe
 * to interpolate into HTML text content or single/double-quoted attributes.
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Remove diacritical marks from a string using Unicode NFD normalization.
 * Handles all Unicode combining marks, not just specific languages.
 *
 * Defensive: external feeds (e.g. Kos\u00edk's product API) sometimes return
 * non-string values where TypeScript types claim string. Coerce to "" rather
 * than crashing \u2014 callers can null-handle the empty result.
 */
export function removeDiacritics(str: string): string {
    if (typeof str !== "string") {
        return "";
    }

    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * `text.slice(0, end)` that never ends on the first half of a surrogate pair. A cut emoji leaves a lone
 * high surrogate, which `JSON.stringify` writes as `\\ud83e`: JavaScript reads that back, but Foundation's
 * `JSONSerialization` rejects the whole document, so one clipped emoji made the hub's Session Details
 * fail with "Could not load earlier turns".
 */
export function sliceWhole(text: string, end: number): string {
    if (end <= 0) {
        return "";
    }

    if (end >= text.length) {
        return text;
    }

    const last = text.charCodeAt(end - 1);
    return last >= 0xd800 && last <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}

/**
 * `text` as a string of its own. In JavaScriptCore (Bun) a `slice`, `trim` or template of a long string can point
 * into it instead of copying, so a 2,000-character preview kept from a 1 MB tool output keeps the whole megabyte
 * alive. Measured 2026-10-08: the parsed turns of a 163 MB Codex rollout held 42 MB of heap, 17 MB once their
 * clipped results were copied; 200 slices of 2,000 chars from 1 MB strings held 191 MB, copied 2 MB.
 * `structuredClone` copies (1.8 µs for 2,000 chars); `normalize`, `padEnd` and templates do not.
 * Use it where a short piece of a long text is KEPT (a preview, a clipped result, a cache entry).
 */
export function detachedCopy(text: string): string {
    return structuredClone(text);
}

/**
 * Truncate text to a maximum length, appending "..." if truncated. A truncated result is a copy of its own, so
 * keeping it does not keep the long text alive (see `detachedCopy`).
 */
export function truncateText(text: string, maxLength: number = 100): string {
    if (text.length <= maxLength) {
        return text;
    }
    if (maxLength <= 3) {
        return detachedCopy(sliceWhole(text, maxLength));
    }
    return detachedCopy(`${sliceWhole(text, maxLength - 3)}...`);
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` characters around the first case-insensitive occurrence of a query word. */
export function snippetAround(text: string, query: string, max = 180): string {
    const flat = collapse(text);

    if (flat.length <= max) {
        return flat;
    }

    const lower = flat.toLowerCase();
    const needles = [query, ...query.split(/\s+/)].map((word) => word.trim().toLowerCase()).filter(Boolean);
    const at = needles.map((needle) => lower.indexOf(needle)).find((index) => index >= 0) ?? 0;
    const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
    const end = Math.min(flat.length, start + max);

    return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
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
 * Left-truncate a path, keeping the meaningful end.
 * Breaks at the first `/` after the truncation point for clean output.
 */
export function truncatePath(path: string, maxLength: number): string {
    if (maxLength <= 0) {
        return "";
    }

    if (maxLength <= 3) {
        return path.slice(0, maxLength);
    }

    if (path.length <= maxLength) {
        return path;
    }

    const truncated = path.slice(-(maxLength - 3));
    const firstSep = truncated.search(/[/\\]/);
    return `...${firstSep > 0 ? truncated.slice(firstSep) : truncated}`;
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

export interface ProbeCooccurrenceArgs {
    source: string;
    primary: RegExp;
    secondary: RegExp[];
    before?: number;
    after?: number;
}

export interface ProbeCooccurrenceResult {
    matched: boolean;
    windows: string[];
}

/**
 * For each match of `primary`, take the window [match.start - before, match.end + after] and
 * test whether EVERY `secondary` regex matches inside that single window.
 */
export function probeCooccurrence({
    source,
    primary,
    secondary,
    before = 800,
    after = 200,
}: ProbeCooccurrenceArgs): ProbeCooccurrenceResult {
    const re = new RegExp(primary.source, primary.flags.includes("g") ? primary.flags : `${primary.flags}g`);
    const windows: string[] = [];

    for (const match of source.matchAll(re)) {
        const start = Math.max(0, (match.index ?? 0) - before);
        const end = Math.min(source.length, (match.index ?? 0) + match[0].length + after);
        const window = source.slice(start, end);

        if (
            secondary.every((s) => {
                s.lastIndex = 0;
                return s.test(window);
            })
        ) {
            windows.push(window);
        }
    }

    return { matched: windows.length > 0, windows };
}

/**
 * Launcher-style matching: every whitespace-separated token of `spec` must appear in `haystack`,
 * case-insensitively, so "grok 4.6" matches "grok-4.6" and "work" matches "cdx-work".
 */
export function matchesSpec(haystack: string, spec: string): boolean {
    const target = haystack.toLowerCase();

    return spec
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .every((token) => target.includes(token));
}
