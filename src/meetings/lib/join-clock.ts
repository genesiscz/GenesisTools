import {
    type JoinPart,
    type MeetingItem,
    type MeetingRecord,
    toJoinedSec,
    toPartSec,
} from "@genesiscz/utils/meetings/record";

export { toJoinedSec, toPartSec };

import { formatClock, parseClock } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

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
const FOREIGN_CLOCK_KEYS = new Set(["voices", "knownAnswer", "corrections"]);
/**
 * The keys whose numbers are line addresses, indexes into the transcript's lines: an item's `transcriptLine`, and the
 * `line` of a finding or of a spelling's reach (`lines[]`). A join moves them by the lines of the parts before.
 */
function isLineAddress(name: string, inFinding: boolean, inLines: boolean): boolean {
    return name === "transcriptLine" || ((inFinding || inLines) && name === "line");
}
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
    /**
     * What the part's line addresses add to count on the joined transcript: the count of the lines of the parts before
     * it (`JoinPart.firstLine`). A move back onto the part's own lines subtracts it.
     */
    lineBase: number;
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
 * on the joined clock, its line addresses on the joined transcript's lines and its ids renumbered. Voice prints and
 * known answers keep their own meeting's clock.
 */
export function movedValue<T>(value: T, move: PartMove, key?: string, inFinding = false, inLines = false): T {
    if (Array.isArray(value)) {
        return value.map((one) =>
            typeof one === "string" && key && ID_ARRAY_KEYS.has(key)
                ? movedId(one, move)
                : movedValue(one, move, undefined, inFinding || key === "findings", key === "lines")
        ) as T;
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const out: Record<string, unknown> = {};

    for (const [name, field] of Object.entries(value)) {
        if (FOREIGN_CLOCK_KEYS.has(name)) {
            out[name] = field;
        } else if (typeof field === "number" && isLineAddress(name, inFinding, inLines)) {
            out[name] = field + move.lineBase;
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

/**
 * A move that only shifts the clock and the line addresses (no ids): `-offsetMs` and `-firstLine` bring a joined value
 * back onto a part's own clock and lines; a sound file's clock keeps the lines (`lineBase` 0).
 */
export function clockMove(offsetMs: number, lineBase = 0): PartMove {
    return {
        offsetMs,
        lineBase,
        ids: new Map(),
        questionBase: 0,
        meeting: { from: "", to: "" },
        rounded: { count: 0 },
    };
}

/** Whether an item of a recording after the first carries a line address, which a join before `firstLine` left on its own lines. */
export function hasLaterLineAddresses(record: Pick<MeetingRecord, "join" | "items">): boolean {
    return record.items.some((item) => {
        const at = "fromSec" in item ? item.fromSec : item.atSec;
        const addressed =
            typeof item.evidence?.transcriptLine === "number" ||
            (item.kind === "term" && item.reach?.lines?.some((one) => one.line !== undefined) === true);
        return addressed && at !== undefined && (joinPartAt(record, at)?.index ?? 0) > 0;
    });
}

/** How far from an item's own seconds the line its address names may start and still be its line. */
const SAME_SECOND = 1;

export interface JoinedLines {
    /** The parts, each with its `firstLine` in the joined transcript. */
    parts: JoinPart[];
    items: MeetingItem[];
    /** Addresses that counted from their own recording's first line, now on the joined transcript's lines. */
    moved: number;
    /** Addresses whose line was found neither way; they stay as they were. */
    unplaced: number;
}

/**
 * Brings a record joined before line addresses moved with the join onto the joined transcript's lines: each part's
 * first line there, and every item's line address (`transcriptLine`, a spelling reach's `line`) that still counts
 * from its own recording's first line. A pass on the joined record wrote some addresses on the joined lines already,
 * so each one is checked against the line it names: the line of the item's recording, of its label (a speaker range or
 * a label item) and of its seconds. An address that names such a line stays; one whose line is `firstLine` lines on
 * moves; one that fits neither stays and is counted as unplaced.
 */
export function joinedLineAddresses(
    record: Pick<MeetingRecord, "join" | "items">,
    transcript: readonly TranscriptEntry[]
): JoinedLines {
    let before = 0;
    const parts = joinParts(record).map((part) => {
        const firstLine = before;
        before += transcript.filter((entry) => entry.sourceMeetingId === part.sourceMeetingId).length;
        return { ...part, firstLine };
    });
    const counts = { moved: 0, unplaced: 0 };
    const placed = (line: number, at: { fromSec: number; toSec: number; label?: string }): number => {
        const found = joinPartAt(record, at.fromSec);
        const part = found ? parts[found.index] : undefined;

        if (!part?.firstLine) {
            return line;
        }

        const names = (index: number) => {
            const entry = transcript[index];
            return (
                entry?.sourceMeetingId === part.sourceMeetingId &&
                entry.startSec !== undefined &&
                entry.startSec >= at.fromSec - SAME_SECOND &&
                entry.startSec <= at.toSec + SAME_SECOND &&
                (at.label === undefined || entry.speaker === at.label)
            );
        };

        if (names(line)) {
            return line;
        }

        if (names(line + part.firstLine)) {
            counts.moved++;
            return line + part.firstLine;
        }

        counts.unplaced++;
        return line;
    };
    const items = record.items.map((item): MeetingItem => {
        const fromSec = "fromSec" in item ? item.fromSec : item.atSec;
        const toSec = "toSec" in item ? item.toSec : item.atSec;
        const label = item.kind === "speaker-range" || item.kind === "label" ? item.label : undefined;
        const line = item.evidence?.transcriptLine;
        let next = item;

        if (typeof line === "number" && fromSec !== undefined && toSec !== undefined) {
            const moved = placed(line, { fromSec, toSec, label });
            next = moved === line ? next : { ...next, evidence: { ...next.evidence, transcriptLine: moved } };
        }

        const reach = next.kind === "term" ? next.reach : undefined;

        if (next.kind === "term" && reach?.lines) {
            const old = reach.lines;
            const lines = old.map((one) =>
                one.line === undefined
                    ? one
                    : { ...one, line: placed(one.line, { fromSec: one.atSec, toSec: one.atSec }) }
            );

            if (lines.some((one, index) => one.line !== old[index]?.line)) {
                next = { ...next, reach: { ...reach, lines } };
            }
        }

        return next;
    });

    return { parts, items, ...counts };
}
