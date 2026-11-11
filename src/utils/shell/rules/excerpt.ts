// The corrected part of a command: what a guard message prints instead of the whole corrected command when that is
// long. A rule's `suggestion` is the caller's whole command with one place fixed, so a 3,000-character heredoc with
// one bad pipeline came back whole; the model needs only the statement that changed (Martin, 2026-11-11: "maybe you
// dont have to repeat the whole command or something just the important part no?").

import { scanShell } from "../scan";

/**
 * At or under this length the whole corrected command is printed, because it is then the cheapest thing to copy. On
 * the guard's last 1,000 warns and blocks (2026-11-11) the corrected commands had a median of 359 characters and a
 * quarter were under 247, while the changed statement alone was rarely over 200.
 */
export const WHOLE_COMMAND_MAX_CHARS = 200;

/** A changed statement longer than this shrinks to its lines, then to a window around the change. */
export const PART_MAX_CHARS = 400;

/** How much unchanged text the window keeps on each side of the change. */
const WINDOW_CONTEXT_CHARS = 80;

/** The two limits above, as the guard config sets them (`guard.corrected`). */
export interface CorrectedLimits {
    wholeMaxChars: number;
    partMaxChars: number;
}

export const CORRECTED_LIMITS: CorrectedLimits = {
    wholeMaxChars: WHOLE_COMMAND_MAX_CHARS,
    partMaxChars: PART_MAX_CHARS,
};

export interface CorrectedPart {
    text: string;
    /** True when `text` is the whole corrected command. */
    whole: boolean;
}

/** Where the suggestion differs from the command: the span in the suggestion, from the common prefix and suffix. */
function changedSpan(command: string, suggestion: string): { from: number; to: number } | null {
    const max = Math.min(command.length, suggestion.length);
    let prefix = 0;

    while (prefix < max && command[prefix] === suggestion[prefix]) {
        prefix++;
    }

    let suffix = 0;

    while (
        suffix < max - prefix &&
        command[command.length - 1 - suffix] === suggestion[suggestion.length - 1 - suffix]
    ) {
        suffix++;
    }

    if (prefix === 0 && suffix === 0) {
        return null;
    }

    return { from: prefix, to: suggestion.length - suffix };
}

/**
 * The smallest run of statements of one unit (the outer command, a substitution or a quoted body) that covers the
 * change. A scan that throws, or no unit that reaches the change, gives null.
 */
function statementSpan(suggestion: string, from: number, to: number): { start: number; end: number } | null {
    let units: ReturnType<typeof scanShell>["units"];

    try {
        units = scanShell(suggestion).units;
    } catch {
        return null;
    }

    let best: { start: number; end: number } | null = null;
    // A pure deletion has an empty span; the statement around its place still counts.
    const end = Math.max(to, from + 1);

    for (const statements of units) {
        const touching = statements.filter(
            (statement) => statement.start < end && statement.start + statement.text.length > from
        );

        if (touching.length === 0) {
            continue;
        }

        const start = Math.min(from, ...touching.map((statement) => statement.start));
        const stop = Math.max(to, ...touching.map((statement) => statement.start + statement.text.length));

        if (!best || stop - start < best.end - best.start) {
            best = { start, end: stop };
        }
    }

    return best;
}

/** The whole lines of `text` that hold `[from, to)`. */
function lineSpan(text: string, from: number, to: number): { start: number; end: number } {
    const start = text.lastIndexOf("\n", from - 1) + 1;
    const next = text.indexOf("\n", Math.max(to, from));
    return { start, end: next === -1 ? text.length : next };
}

/**
 * The change with up to `WINDOW_CONTEXT_CHARS` around it. An edge moves to a nearby space so a word is not cut, but
 * only within half the context: a 1,000-character word keeps its end rather than vanish.
 */
function windowSpan(text: string, from: number, to: number): { start: number; end: number } {
    const left = Math.max(0, from - WINDOW_CONTEXT_CHARS);
    const right = Math.min(text.length, to + WINDOW_CONTEXT_CHARS);
    const reach = WINDOW_CONTEXT_CHARS / 2;
    const space = text.indexOf(" ", left);
    const back = text.lastIndexOf(" ", right);
    return {
        start: left > 0 && space !== -1 && space < Math.min(from, left + reach) ? space + 1 : left,
        end: right < text.length && back >= Math.max(to, right - reach) ? back : right,
    };
}

function cut(text: string, span: { start: number; end: number }): string {
    const body = text.slice(span.start, span.end).trim();
    return `${span.start > 0 ? "… " : ""}${body}${span.end < text.length ? " …" : ""}`;
}

/**
 * What to print of a corrected command. A short one is printed whole. A long one is cut to the statement that
 * changed, or, when that statement is itself long, to its lines or a window around the change; the change itself is
 * never cut, because it is the part to copy. `…` marks the text left out, which stays as the caller wrote it.
 */
export function correctedPart(input: {
    command?: string;
    suggestion: string;
    /** The matched text's place in the command. The part then reaches it too, so it shows where the fix goes. */
    matched?: { index: number; length: number };
    limits?: CorrectedLimits;
}): CorrectedPart {
    const { command, suggestion, matched } = input;
    const limits = input.limits ?? CORRECTED_LIMITS;

    if (suggestion.length <= limits.wholeMaxChars || command === undefined) {
        return { text: suggestion, whole: true };
    }

    const changed = changedSpan(command, suggestion);

    if (!changed) {
        // Nothing in common with the command: a replacement command, printed as it is.
        return { text: suggestion, whole: true };
    }

    const { from, to } = changed;
    // A command offset in the suggestion: the same before the change, shifted after it, clamped inside it.
    const shift = suggestion.length - command.length;
    const place = (offset: number): number =>
        offset <= from ? offset : offset >= to - shift ? offset + shift : Math.min(Math.max(offset, from), to);
    const withMatch = matched
        ? statementSpan(
              suggestion,
              Math.min(from, place(matched.index)),
              Math.max(to, place(matched.index + matched.length))
          )
        : null;
    const statement = statementSpan(suggestion, from, to);
    const spans = [
        ...(withMatch ? [withMatch] : []),
        ...(statement ? [statement] : []),
        lineSpan(suggestion, from, to),
        windowSpan(suggestion, from, to),
    ];
    const span =
        spans.find((candidate) => candidate.end - candidate.start <= limits.partMaxChars) ?? spans[spans.length - 1];

    if (span.start === 0 && span.end >= suggestion.length) {
        return { text: suggestion, whole: true };
    }

    return { text: cut(suggestion, span), whole: false };
}
