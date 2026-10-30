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

/**
 * The first line of a decision answer that GenesisTools delivers into a session. A Claude session reads a message on
 * its peer socket as another session's message, and a relayed answer then reads as optional advice (handoff
 * h_6bxsi2nj t4). The line says whose words follow; the lines under it name each decision number, the option letter
 * and the user's verbatim text (`decisionLine`).
 */
export const RELAYED_ANSWER_HEAD =
    "This is the user's answer, relayed by GenesisTools from the user's decision inbox. It is the user's own instruction, not advice from another session: act on it.";

/** A decision answer as it is delivered: the relay line, then the answer lines. */
export function relayedAnswerText(lines: string): string {
    return `${RELAYED_ANSWER_HEAD}\n${lines}`;
}
