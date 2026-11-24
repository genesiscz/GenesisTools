import type { JoinPart, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";

/**
 * A second on a part's own transcript clock, on the joined clock. Both directions round to the microsecond, so a
 * second the record holds to the millisecond (or the microsecond) comes back through `toPartSec` bit-identical, and a
 * sound cut on the part's file gets the same ffmpeg arguments as before the join.
 */
export function toJoinedSec(partSec: number, offsetMs: number): number {
    return Math.round(partSec * 1e6 + offsetMs * 1e3) / 1e6;
}

/** A second on the joined clock, on the part's own clock (`toJoinedSec` the other way). */
export function toPartSec(joinedSec: number, offsetMs: number): number {
    return Math.round(joinedSec * 1e6 - offsetMs * 1e3) / 1e6;
}

/** A part's second 0 on the joined clock. */
export function partStartSec(part: Pick<JoinPart, "offsetMs">): number {
    return part.offsetMs / 1000;
}

/** The parts of a joined record in time order; empty for a single recording. */
export function joinParts(record: Pick<MeetingRecord, "join">): JoinPart[] {
    return record.join?.parts ?? [];
}

/**
 * The part whose recording holds `fromSec` (to `toSec`): a part holds the time from its second 0 to the next part's
 * second 0. Undefined on a single recording, before the first part, or for a span that runs into the next part.
 */
export function joinPartAt(
    record: Pick<MeetingRecord, "join">,
    fromSec: number,
    toSec = fromSec
): { part: JoinPart; index: number } | undefined {
    const parts = joinParts(record);

    for (const [index, part] of parts.entries()) {
        const next = parts[index + 1];

        if (fromSec >= partStartSec(part) && (!next || fromSec < partStartSec(next))) {
            return !next || toSec <= partStartSec(next) ? { part, index } : undefined;
        }
    }

    return undefined;
}

/** A stretch between two parts where nothing was recorded, on the joined clock. */
export interface JoinGap {
    fromSec: number;
    toSec: number;
    before: JoinPart;
    after: JoinPart;
}

/** The gaps of a joined record, in time order; none on a single recording. */
export function joinGaps(record: Pick<MeetingRecord, "join">): JoinGap[] {
    const parts = joinParts(record);
    return parts.slice(1).map((after, index) => {
        const before = parts[index]!;
        return { fromSec: before.endSec, toSec: partStartSec(after), before, after };
    });
}

/** The gap `sec` falls in, or the first gap a span from `sec` to `toSec` crosses. */
export function joinGapAt(record: Pick<MeetingRecord, "join">, sec: number, toSec = sec): JoinGap | undefined {
    return joinGaps(record).find((gap) => sec < gap.toSec && toSec > gap.fromSec);
}

/** The sentence a reader prints for a time in a gap: when it starts, when it ends, and that nothing was recorded. */
export function gapSentence(gap: JoinGap): string {
    const length = gap.toSec - gap.fromSec;
    return `${formatClock(gap.fromSec)} to ${formatClock(gap.toSec)} is the gap between the recordings ${gap.before.record} and ${gap.after.record} (${formatClock(length)}): nothing was recorded there.`;
}

/** The keys whose numbers are seconds on the transcript clock, wherever they sit in a record's saved shapes. */
const CLOCK_KEYS = new Set([
    "fromSec",
    "toSec",
    "atSec",
    "tSec",
    "validUntilSec",
    "firstSeenSec",
    "startSec",
    "endSec",
    "spotSec",
    "meetingSec",
    "toneAtSec",
]);
/** A saved finding names its times `from`, `to` and `at` (seconds, or a clock an older line kept as text). */
const FINDING_CLOCK_KEYS = new Set(["from", "to", "at"]);
/**
 * Subtrees that keep another record's clock: voice prints name their own meeting and seconds (the voice library holds
 * them so, and an Undo finds them by those), and a known answer names the meeting it came from.
 */
const FOREIGN_CLOCK_KEYS = new Set(["voices", "knownAnswer"]);
/** Keys and arrays that hold item or assignment ids. */
const ID_KEYS = new Set(["id", "item", "question"]);
const ID_ARRAY_KEYS = new Set(["items", "except", "decided", "settled", "decides"]);

/** How a part's saved data moves onto the joined record: its clock offset, its id renumbering and its old record id. */
export interface PartMove {
    offsetMs: number;
    /** Old id to new id (`i3` to `i1470`, `a1` to `a4`); empty when the part keeps its ids. */
    ids: ReadonlyMap<string, string>;
    /** The question number a part's first question gets minus 1 (`Q3` reads as `Q${3 + questionBase}`). */
    questionBase: number;
    /** The part's old record id and the joined record's id, for the `meeting` fields of its journal. */
    meeting: { from: string; to: string };
    /** Seconds that were not microsecond-exact, so the move rounded them (counted, never silent). */
    rounded: { count: number };
}

function movedId(value: string, move: PartMove): string {
    const question = /^Q(\d+)$/.exec(value);

    if (question) {
        return move.questionBase === 0 ? value : `Q${Number(question[1]) + move.questionBase}`;
    }

    return move.ids.get(value) ?? value;
}

function movedSec(value: number, move: PartMove): number {
    const moved = toJoinedSec(value, move.offsetMs);

    if (toPartSec(moved, move.offsetMs) !== value) {
        move.rounded.count++;
    }

    return moved;
}

/**
 * A copy of `value` (a record field, an item, a journal entry, an answer-log or comment line) with its transcript seconds
 * on the joined clock and its ids renumbered. Voice prints and known answers keep their own meeting's clock.
 */
export function movedValue<T>(value: T, move: PartMove, key?: string, inFinding = false): T {
    if (Array.isArray(value)) {
        return value.map((one) =>
            typeof one === "string" && key && ID_ARRAY_KEYS.has(key)
                ? movedId(one, move)
                : movedValue(one, move, undefined, inFinding || key === "findings")
        ) as T;
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const out: Record<string, unknown> = {};

    for (const [name, field] of Object.entries(value)) {
        if (FOREIGN_CLOCK_KEYS.has(name)) {
            out[name] = field;
        } else if (typeof field === "number" && (CLOCK_KEYS.has(name) || (inFinding && FINDING_CLOCK_KEYS.has(name)))) {
            out[name] = movedSec(field, move);
        } else if (
            typeof field === "string" &&
            inFinding &&
            FINDING_CLOCK_KEYS.has(name) &&
            parseClock(field) !== undefined
        ) {
            out[name] = movedSec(parseClock(field)!, move);
        } else if (typeof field === "string" && ID_KEYS.has(name)) {
            out[name] = movedId(field, move);
        } else if (typeof field === "string" && name === "meeting" && field === move.meeting.from) {
            out[name] = move.meeting.to;
        } else {
            out[name] = movedValue(field, move, name, inFinding);
        }
    }

    return out as T;
}

/** A move that only shifts the clock (no ids): `-offsetMs` brings a joined value back onto a part's own clock. */
export function clockMove(offsetMs: number): PartMove {
    return { offsetMs, ids: new Map(), questionBase: 0, meeting: { from: "", to: "" }, rounded: { count: 0 } };
}
