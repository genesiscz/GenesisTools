import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import type { CorrectionsApplied } from "@genesiscz/utils/transcribe/apply";
import { formatClock } from "@genesiscz/utils/transcribe/render";

/** One time for a range of one line ("04:39", not "04:39–04:39"), else the range. */
function span(fromSec: number, toSec: number): string {
    return Math.round(fromSec) === Math.round(toSec)
        ? formatClock(fromSec)
        : `${formatClock(fromSec)}–${formatClock(toSec)}`;
}

export function itemWhat(item: MeetingItem): string {
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
    return `${item.heard} → ${item.proposed ?? "?"}${occurrences}`;
}

type AppliedCounts = Omit<CorrectionsApplied, "entries" | "outcomes">;

/** Each counter of `transcript`'s summary with its words for one and for more, in the order the corrections apply. */
const APPLIED_PARTS: Array<[keyof AppliedCounts, string, string]> = [
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
