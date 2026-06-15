/**
 * Pure tokenization and bug-fix-commit classification.
 *
 * These functions are deterministic and side-effect free so they can be
 * unit-tested without spawning git or touching disk.
 */

/** Keywords whose presence in a commit subject marks it as a bug-fix commit. */
export const BUGFIX_KEYWORDS = ["fix", "fixes", "fixed", "bug", "bugfix", "revert", "hotfix", "patch", "regression"];

/**
 * Tokens shorter than this are dropped. Single/two-char fragments (`i`, `x`,
 * `if`, `id`) are mostly noise for lexical similarity.
 */
const MIN_TOKEN_LENGTH = 2;

/**
 * Common English + diff-noise stop words. Kept small and deterministic — the
 * goal is to stop the most frequent filler from dominating the cosine score,
 * not to do real linguistic stemming.
 */
const STOP_WORDS = new Set<string>([
    "the",
    "and",
    "for",
    "this",
    "that",
    "with",
    "from",
    "into",
    "are",
    "was",
    "were",
    "but",
    "not",
    "you",
    "your",
    "they",
    "their",
    "have",
    "has",
    "had",
    "will",
    "would",
    "should",
    "could",
    "can",
    "all",
    "any",
    "out",
    "use",
    "get",
    "set",
    "var",
    "let",
    "const",
    "return",
    "import",
    "export",
    "function",
    "diff",
    "git",
    "index",
    "true",
    "false",
    "null",
    "undefined",
]);

/**
 * Split text into normalized lexical tokens.
 *
 * - lowercases everything
 * - splits identifiers on camelCase / snake_case / kebab-case boundaries
 * - splits on any non-alphanumeric run
 * - drops stop words and tokens shorter than {@link MIN_TOKEN_LENGTH}
 */
export function tokenize(text: string): string[] {
    if (!text) {
        return [];
    }

    // Insert spaces at camelCase boundaries so `parseUserId` → `parse User Id`.
    const camelSplit = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

    const rawTokens = camelSplit
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);

    const tokens: string[] = [];
    for (const token of rawTokens) {
        if (token.length < MIN_TOKEN_LENGTH) {
            continue;
        }

        if (STOP_WORDS.has(token)) {
            continue;
        }

        tokens.push(token);
    }

    return tokens;
}

/**
 * Build a term-frequency map from a list of tokens.
 */
export function termFrequencies(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    return tf;
}

/**
 * True when a commit subject looks like a bug fix / revert / hotfix.
 *
 * Matches whole words only, so `prefix` does not count as `fix` and
 * `affixes` does not count as `fix`.
 */
export function isBugFixSubject(subject: string): boolean {
    if (!subject) {
        return false;
    }

    const words = new Set(tokenizeRaw(subject));
    for (const keyword of BUGFIX_KEYWORDS) {
        if (words.has(keyword)) {
            return true;
        }
    }

    return false;
}

/**
 * Lowercased word split WITHOUT stop-word / length filtering. Used by the
 * classifier so short keywords like `fix` survive.
 */
function tokenizeRaw(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/**
 * Map a file path to a coarse "type" token (its lowercased extension, or
 * `noext` when there is none). Used to weight same-file-type matches.
 */
export function fileTypeToken(filePath: string): string {
    const base = filePath.split("/").pop() ?? filePath;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) {
        return "noext";
    }

    return base.slice(dot + 1).toLowerCase();
}
