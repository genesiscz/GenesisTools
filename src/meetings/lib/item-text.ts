import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import type { CorrectionsApplied } from "@genesiscz/utils/transcribe/apply";
import { formatClock } from "@genesiscz/utils/transcribe/render";

/** One time when both ends print the same ("04:39", not "04:39–04:39"), else the range. */
function span(fromSec: number, toSec: number): string {
    const from = formatClock(fromSec);
    const to = formatClock(toSec);
    return from === to ? from : `${from}–${to}`;
}

/**
 * One line for an item. `width`: the column it must fit; a term's quote is shortened inside its quotes so the source
 * stays visible (`items` cuts the cell at 90 characters, which cut the source off a long quote). Other text is cut by
 * the caller.
 */
export function itemWhat(item: MeetingItem, options: { width?: number } = {}): string {
    if (item.kind === "removal") {
        return `${formatClock(item.fromSec)} remove local speech: ${item.heard}`;
    }
    if (item.kind === "speaker-range") {
        const who = item.speaker ?? `? (${item.candidates?.join(", ") || "unknown"})`;
        return `${item.label} ${span(item.fromSec, item.toSec)} → ${who}`;
    }

    if (item.kind === "join") {
        return `${formatClock(item.atSec)} "${item.joined ?? ""}"${item.speaker ? ` → ${item.speaker}` : ""}`;
    }

    if (item.kind === "question") {
        const range = `${formatClock(item.fromSec)}–${formatClock(item.toSec)}`;
        const said = item.answer ? `→ ${item.answer}` : item.choices.length > 0 ? `(${item.choices.join(" / ")})` : "";
        return `${range} ${item.question} ${said}`.trim();
    }

    if (item.kind === "label") {
        return `${item.label} ${span(item.fromSec, item.toSec)} tracks no one person`;
    }

    const occurrences = typeof item.evidence?.occurrences === "number" ? ` ×${item.evidence.occurrences}` : "";
    const head = `${item.heard} → `;
    const room = options.width === undefined ? undefined : options.width - head.length - occurrences.length;
    return `${head}${termAnswer(item, room)}${occurrences}`;
}

/**
 * A term's right spelling; else the document line its words read aloud; else what they mean; "?" when none is known.
 * `room`: the characters the answer may take; only a quote is shortened to it, and its source always stays.
 */
function termAnswer(item: Extract<MeetingItem, { kind: "term" }>, room?: number): string {
    if (item.proposed) {
        return item.proposed;
    }

    if (item.quote) {
        const source = ` (quote from ${item.quote.source})`;
        const text = item.quote.text;
        // The two quote marks and at least one character of the quote stay.
        const fits = room === undefined ? text.length : Math.max(1, room - source.length - 2);
        const shown = text.length <= fits ? text : `${text.slice(0, Math.max(0, fits - 1))}…`;
        return `"${shown}"${source}`;
    }

    if (item.meaning) {
        return `${item.meaning} (meaning)`;
    }

    return "?";
}

type AppliedCounts = Omit<CorrectionsApplied, "entries" | "outcomes">;

/** Each counter of `transcript`'s summary with its words for one and for more, in the order the corrections apply. */
const APPLIED_PARTS: Array<[keyof AppliedCounts, string, string]> = [
    ["removed", "removed local speech line", "removed local speech lines"],
    ["labels", "renamed line", "renamed lines"],
    ["ranges", "re-attributed line", "re-attributed lines"],
    ["joins", "join", "joins"],
    ["terms", "term fix", "term fixes"],
    ["fixes", "dictionary fix", "dictionary fixes"],
    ["spoken", "spoken form", "spoken forms"],
    ["fuzzy", "fuzzy match", "fuzzy matches"],
    ["expansions", "expansion", "expansions"],
    ["meanings", "meaning", "meanings"],
    ["marks", "quote or meaning of spoken words", "quotes and meanings of spoken words"],
    ["unclear", "unclear mark", "unclear marks"],
];

/** The `transcript` summary: only what changed a line, so a run that changed nothing does not list eleven zeros (R2-MC3). */
export function appliedLine(applied: AppliedCounts): string {
    const parts = APPLIED_PARTS.filter(([key]) => applied[key] > 0).map(
        ([key, one, more]) => `${applied[key]} ${applied[key] === 1 ? one : more}`
    );
    return parts.length > 0
        ? `applied: ${parts.join(", ")}`
        : "applied: nothing; no confirmed item, rename or dictionary entry changed a line";
}
