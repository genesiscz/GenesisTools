import { nameKey } from "@genesiscz/utils/meetings/people";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { MeetingSeats, RemoteSeat } from "@genesiscz/utils/meetings/seats";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { LINE_AT_TOLERANCE_SEC } from "@genesiscz/utils/transcribe/lines";
import { baselineStays } from "./person-stays";

type Seat = "room" | "remote" | "unsure";
interface SeatPerson {
    name: string;
    seat: Seat;
    reason: string;
    confidence: number;
}
type ChannelLine = Pick<LineEvidence, "label" | "startSec" | "energyMicRaw">;
interface Range {
    label: string;
    fromSec: number;
    toSec: number;
    person?: string;
}

/** Confirmed single voices and explicit assignments. An older confirmation can predate the actor field. */
export function decidedSeatRanges(record: MeetingRecord): Range[] {
    const ranges: Range[] = [];
    for (const item of record.items) {
        if (item.kind !== "speaker-range" || item.status !== "confirmed") {
            continue;
        }
        const actor = item.decision?.actor?.kind;
        if (actor && actor !== "window" && actor !== "listen" && actor !== "cli") {
            continue;
        }
        ranges.push({
            label: item.label,
            fromSec: item.fromSec,
            toSec: item.toSec,
            person: item.voices?.length || item.segments?.length ? undefined : item.speaker,
        });
    }
    // Match the transcript's precedence: the latest assignment wins over a confirmed item.
    for (const assignment of [...(record.speakers.assignments ?? [])].sort((a, b) => a.at.localeCompare(b.at))) {
        ranges.push({
            label: assignment.label,
            fromSec: assignment.fromSec - LINE_AT_TOLERANCE_SEC,
            toSec: assignment.toSec + LINE_AT_TOLERANCE_SEC,
            person: assignment.person,
        });
    }
    return ranges;
}

interface Facts {
    name: string;
    self: boolean;
    roster: boolean;
    hasRange: boolean;
    lines: number;
    mic: number;
    call: number;
}
type Stay = { fromSec: number; toSec?: number };

function infer(facts: Facts, reads: ReadonlyArray<ReadonlySet<string>>): Omit<SeatPerson, "name"> {
    if (facts.self) {
        return { seat: "room", reason: "Recording participant (self).", confidence: 1 };
    }
    for (const [seat, count, channel] of [
        ["room", facts.mic, "microphone"],
        ["remote", facts.call, "call"],
    ] as const) {
        if (facts.lines >= 5 && count / facts.lines >= 0.6) {
            return {
                seat,
                reason: `${count} of ${facts.lines} decided lines on the ${channel}.`,
                confidence: count / facts.lines,
            };
        }
    }
    if (facts.hasRange) {
        if (facts.lines === 0) {
            return {
                seat: "unsure",
                reason: "A speaker decision is saved, but its transcript lines are unavailable.",
                confidence: 0,
            };
        }
        return {
            seat: "unsure",
            reason: `${facts.lines} decided lines: ${facts.mic} on the microphone, ${facts.call} on the call. Need 5 lines and 60% on one channel.`,
            confidence: 0,
        };
    }
    if (facts.roster) {
        const key = nameKey(facts.name);
        if (reads.length > 0 && reads.every((muted) => muted.has(key))) {
            const count = reads.length === 1 ? "the only roster read" : `all ${reads.length} roster reads`;
            return { seat: "unsure", reason: `Muted on ${count} while present.`, confidence: 0 };
        }
        return { seat: "remote", reason: "Listed on the call roster with no decided lines.", confidence: 0.5 };
    }
    return { seat: "unsure", reason: "No call roster entry or decided lines.", confidence: 0 };
}

/** Roster records can overlap. Coalesce only touching/overlapping stays and keep each rejoin. */
function remoteSeats(name: string, stays: Stay[] | undefined): RemoteSeat[] {
    if (!stays) {
        return [{ name }];
    }
    const rows: RemoteSeat[] = [];
    for (const stay of [...stays].sort((a, b) => a.fromSec - b.fromSec)) {
        if (stay.toSec !== undefined && stay.toSec <= stay.fromSec) {
            continue;
        }
        const last = rows.at(-1);
        if (last && stay.fromSec <= (last.toSec ?? Infinity)) {
            last.toSec =
                last.toSec === undefined || stay.toSec === undefined ? undefined : Math.max(last.toSec, stay.toSec);
        } else {
            rows.push({ name, fromSec: stay.fromSec, ...(stay.toSec === undefined ? {} : { toSec: stay.toSec }) });
        }
    }
    return rows;
}

export function suggestSeats(options: {
    record: MeetingRecord;
    ranges: readonly Range[];
    lines: readonly ChannelLine[];
    room?: readonly string[];
    remote?: readonly string[];
}): { seats: MeetingSeats; people: SeatPerson[] } {
    const { record, ranges, lines } = options;
    const facts = new Map<string, Facts>();
    function person(name: string): Facts {
        const key = nameKey(name);
        const known = facts.get(key);
        if (known) {
            return known;
        }
        const row = { name: name.trim(), self: false, roster: false, hasRange: false, lines: 0, mic: 0, call: 0 };
        facts.set(key, row);
        return row;
    }
    for (const participant of record.participants) {
        const row = person(participant.name);
        row.self ||= participant.self === true;
        row.roster ||=
            participant.from.includes("platform-roster") ||
            participant.firstSeenSec !== undefined ||
            !!participant.stays?.some((stay) => stay.source === "platform-roster" || stay.source === "attendance");
    }
    for (const stay of record.attendance?.people ?? []) {
        const row = person(stay.name);
        row.roster = true;
        row.self ||= stay.self === true;
    }
    const byLabel = new Map<string, Range[]>();
    for (const range of ranges) {
        const group = byLabel.get(range.label);
        if (group) {
            group.push(range);
        } else {
            byLabel.set(range.label, [range]);
        }
    }
    for (const line of lines) {
        const range = byLabel.get(line.label)?.findLast((r) => line.startSec >= r.fromSec && line.startSec <= r.toSec);
        if (!range?.person) {
            continue;
        }
        const row = person(range.person);
        row.hasRange = true;
        row.lines++;
        if (line.energyMicRaw !== undefined) {
            row.mic += Number(line.energyMicRaw > 0.65);
            row.call += Number(line.energyMicRaw < 0.35);
        }
    }
    if (lines.length === 0) {
        for (const range of ranges) {
            if (range.person) {
                person(range.person).hasRange = true;
            }
        }
    }
    const manual = new Map<string, "room" | "remote">();
    for (const seat of ["room", "remote"] as const) {
        for (const name of options[seat] ?? []) {
            const key = nameKey(name);
            if (!key || (manual.has(key) && manual.get(key) !== seat)) {
                throw new Error("Give each person one nonempty name and one seat.");
            }
            person(name);
            manual.set(key, seat);
        }
    }
    const observations = (record.evidence?.indicator ?? [])
        .filter((read) => !read.reason && (!read.speakingUnknown || read.muted !== undefined))
        .map((read) => ({
            at: read.tSec,
            muted: new Set(read.muted?.map(nameKey)),
        }));
    const seats: MeetingSeats = { room: [], remote: [] };
    const people: SeatPerson[] = [];
    for (const [key, row] of facts) {
        const stays = baselineStays(record, row.name)?.map(({ stay }) => stay);
        const reads = observations.filter(
            ({ at }) =>
                !stays || stays.some((stay) => at >= stay.fromSec && (stay.toSec === undefined || at < stay.toSec))
        );
        const picked = manual.get(key);
        const decision = picked
            ? { seat: picked, reason: "Set by hand.", confidence: 1 }
            : infer(
                  row,
                  reads.map(({ muted }) => muted)
              );
        people.push({ name: row.name, ...decision });
        if (decision.seat === "room") {
            seats.room.push(row.name);
        } else if (decision.seat === "remote") {
            seats.remote.push(...remoteSeats(row.name, stays));
        }
    }
    return { seats, people };
}
