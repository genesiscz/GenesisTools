/**
 * The sentences a failed delivery is shown as. One place: the live send (`paneMiss`), and rows stored
 * before the rework, which kept the raw cmux error in `delivery.target`, read through the same rules.
 */

/** The sentence behind a raw cmux or codex failure text; null when it names no known cause. */
export function deliverySentence(text: string): string | null {
    if (/not_found|Workspace not found|Surface not found/i.test(text)) {
        return "the cmux workspace of this session was closed";
    }

    if (/not reachable|not running|ECONNREFUSED/i.test(text)) {
        return "cmux is not running";
    }

    if (/no cmux pane/i.test(text)) {
        return "no cmux pane runs this session";
    }

    return null;
}

const WHY_MAX = 160;

/**
 * A stored or raw "why" as one sentence: the known cause when the text names one, the text itself
 * when it is already one short line (an earlier sentence), else the generic sentence. A multi-line
 * dump never comes back as the sentence.
 */
export function whySentence(text: string): string {
    const known = deliverySentence(text);

    if (known) {
        return known;
    }

    const line = text.trim();
    return line.length > 0 && !line.includes("\n") && line.length <= WHY_MAX ? line : "the cmux send failed";
}

/** True for the raw multi-line error a pre-rework row stored in `target`. */
export function looksLikeDump(text: string): boolean {
    return text.includes("\n") || /^ERROR\b/i.test(text.trim());
}
