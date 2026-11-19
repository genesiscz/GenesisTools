import { nameKey, type RoomDevice, rosterAccountKey } from "@genesiscz/utils/meetings/people";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { withoutEmptyRemoteSeats } from "@genesiscz/utils/meetings/room-people";
import {
    type MeetingSeats,
    meetingSeatsSchema,
    microphoneSide,
    type RemoteSeat,
    seatSpan,
} from "@genesiscz/utils/meetings/seats";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { LINE_AT_TOLERANCE_SEC } from "@genesiscz/utils/transcribe/lines";
import { baselineStays } from "./person-stays";
import type { SeatVoiceHint } from "./seat-voice";
import type { MeetingsResult } from "./service/api";
import type { MeetingsClient } from "./service/client";

export async function applySuggestedSeats(options: {
    client: MeetingsClient;
    view: MeetingsResult<"meeting.seats.suggest">;
    replace?: boolean;
}): Promise<boolean> {
    const { client, view, replace } = options;
    const { seats } = view.suggestion;
    if ((!seats.room.length && !seats.remote.length) || (view.current && !replace)) {
        return false;
    }
    await client.call("decision.apply", {
        meeting: view.meeting,
        action: { kind: "set", seats, ...(replace ? {} : { seatsIfAbsent: true }) },
    });
    return true;
}

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
interface RosterRead {
    at: number;
    muted?: Set<string>;
    speaking: Set<string>;
}

function infer(facts: Facts, reads: readonly RosterRead[]): Omit<SeatPerson, "name"> {
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
        const explicit = reads.filter((read) => read.muted !== undefined);
        const muted = explicit.filter((read) => read.muted?.has(key)).length;
        const spoke = reads.some((read) => read.speaking.has(key) && !read.muted?.has(key));
        let reason = "Listed on the call. No explicit mute reads while present.";
        if (explicit.length) {
            reason = `Physical seat unknown. ${muted} of ${explicit.length} explicit mute lists included this account.`;
            if (!spoke && muted / explicit.length >= 0.8) {
                const count =
                    muted === reads.length
                        ? reads.length === 1
                            ? "the only roster read"
                            : `all ${reads.length} roster reads`
                        : `${muted} of ${explicit.length} explicit mute reads`;
                reason = `Muted on ${count} while present.`;
            }
        }
        if (spoke) {
            reason += " Observed speaking on the call.";
        }
        return { seat: "unsure", reason, confidence: 0 };
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
    devices?: readonly RoomDevice[];
    ranges: readonly Range[];
    lines: readonly ChannelLine[];
    room?: Readonly<MeetingSeats["room"]>;
    remote?: ReadonlyArray<string | RemoteSeat>;
}): { seats: MeetingSeats; people: SeatPerson[] } {
    const { record, ranges, lines } = options;
    const devices = new Set(options.devices?.map(({ account }) => rosterAccountKey(account)));
    const human = (name: string) => !devices.has(rosterAccountKey(name));
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
        if (!human(participant.name)) {
            continue;
        }
        const row = person(participant.name);
        row.self ||= participant.self === true;
        row.roster ||=
            participant.from.includes("platform-roster") ||
            participant.firstSeenSec !== undefined ||
            !!participant.stays?.some((stay) => stay.source === "platform-roster" || stay.source === "attendance");
    }
    for (const stay of record.attendance?.people ?? []) {
        if (!human(stay.name)) {
            continue;
        }
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
        if (!range?.person || !human(range.person)) {
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
            if (range.person && human(range.person)) {
                person(range.person).hasRange = true;
            }
        }
    }
    const manual = new Map<string, "room" | "remote">();
    const roomStays = (options.room ?? []).filter((row) => typeof row !== "string");
    const remoteStays = (options.remote ?? []).filter((row) => typeof row !== "string");
    const explicitStays = new Set([...roomStays, ...remoteStays].map((row) => nameKey(row.name)));
    if (explicitStays.size) {
        meetingSeatsSchema.parse({ room: roomStays, remote: remoteStays });
    }
    for (const seat of ["room", "remote"] as const) {
        for (const entry of options[seat] ?? []) {
            const { name } = seatSpan(entry);
            if (!human(name)) {
                throw new Error(`${name} is a mapped room device. Unmap the account before seating it as a person.`);
            }
            person(name);
            if (typeof entry !== "string") {
                continue;
            }
            const key = nameKey(name);
            if (explicitStays.has(key)) {
                throw new Error("Give a person's stays as intervals or choose a seat by name.");
            }
            if (!key || (manual.has(key) && manual.get(key) !== seat)) {
                throw new Error("Give each person one nonempty name and one seat.");
            }
            manual.set(key, seat);
        }
    }
    const observations: RosterRead[] = (record.evidence?.indicator ?? [])
        .filter(
            (read) =>
                !read.reason &&
                Number.isFinite(read.tSec) &&
                read.tSec >= 0 &&
                (read.validUntilSec === undefined || read.validUntilSec > read.tSec)
        )
        .map((read) => ({
            at: read.tSec,
            muted: read.muted && new Set(read.muted.filter(human).map(nameKey)),
            speaking: new Set(read.speakingUnknown ? [] : read.speaking.filter(human).map(nameKey)),
        }));
    // A fresh hand choice can move one person. Keep everyone else's rows, including gaps, labels and devices.
    const keep = (name: string, side: "room" | "remote") => {
        if (!human(name)) {
            return false;
        }
        person(name);
        const key = nameKey(name);
        const override = manual.get(key);
        return !explicitStays.has(key) && (override === undefined || override === side);
    };
    const saved = withoutEmptyRemoteSeats(record.seats);
    const seats: MeetingSeats = {
        room: [...(saved?.room ?? []).filter((row) => keep(seatSpan(row).name, "room")), ...roomStays],
        remote: [...(saved?.remote ?? []).filter((row) => keep(row.name, "remote")), ...remoteStays],
    };
    const roomNames = new Set(seats.room.map((row) => nameKey(seatSpan(row).name)));
    const remoteNames = new Set(seats.remote.map((row) => nameKey(row.name)));
    if (saved?.microphones) {
        seats.microphones = saved.microphones.flatMap((group) => {
            const names = microphoneSide(saved, group) === "room" ? roomNames : remoteNames;
            const members = group.people.filter((name) => human(name) && names.has(nameKey(name)));
            return members.length ? [{ ...group, people: members }] : [];
        });
    }
    const people: SeatPerson[] = [];
    for (const [key, row] of facts) {
        const inRoom = roomNames.has(key);
        const onCall = remoteNames.has(key);
        if (inRoom || onCall) {
            people.push({
                name: row.name,
                seat: inRoom && onCall ? "unsure" : inRoom ? "room" : "remote",
                reason: explicitStays.has(key)
                    ? "Seat intervals set by hand."
                    : inRoom && onCall
                      ? "Saved room and remote intervals."
                      : "Saved seat.",
                confidence: 1,
            });
            continue;
        }
        const stays = baselineStays(record, row.name)?.map(({ stay }) => stay);
        const reads = observations.filter(
            ({ at }) =>
                !stays || stays.some((stay) => at >= stay.fromSec && (stay.toSec === undefined || at < stay.toSec))
        );
        const picked = manual.get(key);
        const decision = picked ? { seat: picked, reason: "Set by hand.", confidence: 1 } : infer(row, reads);
        people.push({ name: row.name, ...decision });
        if (decision.seat === "room") {
            seats.room.push(row.name);
        } else if (decision.seat === "remote") {
            seats.remote.push(...remoteSeats(row.name, stays));
        }
    }
    return { seats, people };
}

/** Add sound only where a saved seat, a hand choice and the decided-line rule left the preview open. */
export function includeSeatVoiceHints(options: {
    record: MeetingRecord;
    suggestion: ReturnType<typeof suggestSeats>;
    hints: ReadonlyArray<SeatVoiceHint>;
}): void {
    const { record, suggestion, hints } = options;
    const byName = new Map(hints.map((hint) => [nameKey(hint.person), hint]));
    for (const person of suggestion.people) {
        // A saved move between room and remote also appears as "unsure", with confidence 1.
        if (person.seat !== "unsure" || person.confidence === 1) {
            continue;
        }
        const hint = byName.get(nameKey(person.name));
        if (!hint) {
            continue;
        }
        person.seat = hint.seat;
        person.confidence = hint.confidence;
        person.reason = hint.seat === "unsure" ? `${person.reason} ${hint.reason}` : hint.reason;
        if (hint.seat === "room") {
            suggestion.seats.room.push(person.name);
        } else if (hint.seat === "remote") {
            suggestion.seats.remote.push(
                ...remoteSeats(
                    person.name,
                    baselineStays(record, person.name)?.map(({ stay }) => stay)
                )
            );
        }
    }
}

/** The preview's hand choices take effect together. A decided-line inference is still a rival voice on either side. */
export function explicitPreviewSeats(options: {
    saved?: MeetingSeats;
    edits: Pick<Parameters<typeof suggestSeats>[0], "room" | "remote">;
    suggested: MeetingSeats;
}): MeetingSeats | undefined {
    const { saved, edits, suggested } = options;
    if (!edits.room?.length && !edits.remote?.length) {
        return saved;
    }
    const names = new Set(
        [...(saved?.room ?? []), ...(saved?.remote ?? []), ...(edits.room ?? []), ...(edits.remote ?? [])].map((row) =>
            nameKey(seatSpan(row).name)
        )
    );
    return {
        ...suggested,
        room: suggested.room.filter((row) => names.has(nameKey(seatSpan(row).name))),
        remote: suggested.remote.filter((row) => names.has(nameKey(row.name))),
    };
}
