import type { MeetingItem } from "@genesiscz/utils/meetings/record";
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
