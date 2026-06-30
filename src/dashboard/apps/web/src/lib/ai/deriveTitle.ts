const MAX_TITLE_LENGTH = 48;

/**
 * Derive a short conversation title from the first user message.
 * Collapses whitespace, trims to a word boundary near MAX_TITLE_LENGTH, and
 * returns null when there's nothing usable so the caller keeps its default.
 */
export function deriveTitle(message: string): string | null {
    const cleaned = message.replace(/\s+/g, " ").trim();

    if (!cleaned) {
        return null;
    }

    if (cleaned.length <= MAX_TITLE_LENGTH) {
        return cleaned;
    }

    const sliced = cleaned.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = sliced.lastIndexOf(" ");
    const base = lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced;

    return `${base.trim()}…`;
}
