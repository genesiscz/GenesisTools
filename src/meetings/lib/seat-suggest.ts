import { IntervalIndex } from "@genesiscz/utils/array";
import { nameKey, type RoomDevice, roomDeviceAccountKeys, rosterAccountKey } from "@genesiscz/utils/meetings/people";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { withoutEmptyRemoteSeats } from "@genesiscz/utils/meetings/room-people";
import {
    type MeetingSeats,
    meetingSeatsSchema,
    microphoneSide,
    type RemoteSeat,
    type SeatSpan,
    seatSpan,
} from "@genesiscz/utils/meetings/seats";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { LINE_AT_TOLERANCE_SEC } from "@genesiscz/utils/transcribe/lines";
import { baselineStays } from "./person-stays";
import type { SeatVoiceHint } from "./seat-voice";
import type { MeetingsResult } from "./service/api";
import type { MeetingsClient } from "./service/client";
import type { SamePerson } from "./speaker-scores";

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
    /** The key the person's row is filed under: the name key of the first name seen for them. */
    key: string;
    /** The name the seat shows: a name typed for the seat, else the first name that is not an email address. */
    name: string;
    /** Every name the meeting gives this person: a roster address, a typed seat name, a decided speaker. */
    names: string[];
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
                reason: "A speaker decision is saved, but no transcript line counts for it.",
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
        const key = facts.key;
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
    /** One person under two names (a people-book merge): their names make one seat row. */
    samePerson?: SamePerson;
}): { seats: MeetingSeats; people: SeatPerson[] } {
    const { record, ranges, lines, samePerson } = options;
    const devices = roomDeviceAccountKeys(options.devices);
    const human = (name: string) => !devices.has(rosterAccountKey(name));
    const facts = new Map<string, Facts>();
    // The row a name belongs to: its own name key, or the row that already holds another name of this person.
    function keyOf(name: string): string {
        const own = nameKey(name);
        if (facts.has(own) || !samePerson) {
            return own;
        }

        for (const row of facts.values()) {
            if (row.names.some((known) => nameKey(known) === own || samePerson(known, name))) {
                return row.key;
            }
        }

        return own;
    }
    function person(name: string, byHand = false): Facts {
        const key = keyOf(name);
        const trimmed = name.trim();
        const known = facts.get(key);
        if (known) {
            if (!known.names.includes(trimmed)) {
                known.names.push(trimmed);
            }

            // Another name of the person: the one typed for the seat wins, and a name wins over an address.
            if (
                nameKey(trimmed) !== nameKey(known.name) &&
                (byHand || (isAddress(known.name) && !isAddress(trimmed)))
            ) {
                known.name = trimmed;
            }

            return known;
        }
        const row = {
            key,
            name: trimmed,
            names: [trimmed],
            self: false,
            roster: false,
            hasRange: false,
            lines: 0,
            mic: 0,
            call: 0,
        };
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
        if (range.person && human(range.person)) {
            person(range.person).hasRange = true;
        }

        const group = byLabel.get(range.label);
        if (group) {
            group.push(range);
        } else {
            byLabel.set(range.label, [range]);
        }
    }
    // The last range that holds a line's start wins, as before; each label's ranges are indexed by time once.
    const indexed = new Map<string, IntervalIndex<{ range: Range; at: number }>>();
    for (const [label, group] of byLabel) {
        const index = new IntervalIndex<{ range: Range; at: number }>();
        for (const [at, range] of group.entries()) {
            index.add(range.fromSec, range.toSec, { range, at });
        }
        indexed.set(label, index);
    }
    for (const line of lines) {
        const range = indexed
            .get(line.label)
            ?.containing(line.startSec)
            .reduce<{ range: Range; at: number } | undefined>(
                (last, hit) => (!last || hit.at > last.at ? hit : last),
                undefined
            )?.range;
        if (!range?.person || !human(range.person)) {
            continue;
        }
        const row = person(range.person);
        row.lines++;
        if (line.energyMicRaw !== undefined) {
            row.mic += Number(line.energyMicRaw > 0.65);
            row.call += Number(line.energyMicRaw < 0.35);
        }
    }
    const manual = new Map<string, "room" | "remote">();
    const roomStays = (options.room ?? []).filter((row) => typeof row !== "string");
    const remoteStays = (options.remote ?? []).filter((row) => typeof row !== "string");
    if (roomStays.length || remoteStays.length) {
        meetingSeatsSchema.parse({ room: roomStays, remote: remoteStays });
    }
    // Every hand-given name first, so two names of one person given together find the same row.
    for (const seat of ["room", "remote"] as const) {
        for (const entry of options[seat] ?? []) {
            const { name } = seatSpan(entry);
            if (!human(name)) {
                throw new Error(`${name} is a mapped room device. Unmap the account before seating it as a person.`);
            }
            person(name, true);
        }
    }
    const explicitStays = new Set([...roomStays, ...remoteStays].map((row) => keyOf(row.name)));
    for (const seat of ["room", "remote"] as const) {
        for (const entry of options[seat] ?? []) {
            if (typeof entry !== "string") {
                continue;
            }
            const key = keyOf(entry);
            if (explicitStays.has(key)) {
                throw new Error("Give a person's stays as intervals or choose a seat by name.");
            }
            if (!key || (manual.has(key) && manual.get(key) !== seat)) {
                throw new Error("Give each person one nonempty name and one seat.");
            }
            manual.set(key, seat);
        }
    }
    // A fresh hand choice can move one person. Keep everyone else's rows, including gaps, labels and devices.
    const keep = (name: string, side: "room" | "remote") => {
        if (!human(name)) {
            return false;
        }
        const { key } = person(name);
        const override = manual.get(key);
        return !explicitStays.has(key) && (override === undefined || override === side);
    };
    const saved = withoutEmptyRemoteSeats(record.seats);
    const seats: MeetingSeats = oneRowPerStretch(
        {
            room: [...(saved?.room ?? []).filter((row) => keep(seatSpan(row).name, "room")), ...roomStays],
            remote: [...(saved?.remote ?? []).filter((row) => keep(row.name, "remote")), ...remoteStays],
        },
        (name) => facts.get(keyOf(name))
    );
    const roomNames = new Set(seats.room.map((row) => keyOf(seatSpan(row).name)));
    const remoteNames = new Set(seats.remote.map((row) => keyOf(row.name)));
    if (saved?.microphones) {
        // A member shows the name its seat row shows, so one person is one member.
        const rowNames = (side: "room" | "remote") =>
            new Map(
                [...seats[side]]
                    .reverse()
                    .map((row): [string, string] => [keyOf(seatSpan(row).name), seatSpan(row).name])
            );
        const shown = { room: rowNames("room"), remote: rowNames("remote") };
        seats.microphones = saved.microphones.flatMap((group) => {
            const side = microphoneSide(saved, group) === "room" ? "room" : "remote";
            const members = [
                ...new Set(
                    group.people.flatMap((name) => {
                        const row = human(name) ? shown[side].get(keyOf(name)) : undefined;
                        if (row === undefined) {
                            return [];
                        }

                        return [nameKey(row) === nameKey(name) ? name : row];
                    })
                ),
            ];
            return members.length ? [{ ...group, people: members }] : [];
        });
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
            muted: read.muted && new Set(read.muted.filter(human).map(keyOf)),
            speaking: new Set(read.speakingUnknown ? [] : read.speaking.filter(human).map(keyOf)),
        }));
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
        // The stays are filed under whichever of the person's names the roster used.
        const stays = [row.name, ...row.names]
            .map((name) => baselineStays(record, name))
            .find((found) => found !== undefined)
            ?.map(({ stay }) => stay);
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

/** A roster account that is an email address: the seat shows a person's name over it. */
function isAddress(name: string): boolean {
    return name.includes("@");
}

/**
 * One row per person and stretch. A seat row under another name of a person shows the person's seat name, a row a
 * stretch of theirs on the same side already holds is dropped, and a row that would overlap one of theirs keeps its own
 * name, as it did, so the seats still save.
 */
function oneRowPerStretch(seats: MeetingSeats, personOf: (name: string) => Facts | undefined): MeetingSeats {
    const held = new Map<string, Array<{ side: "room" | "remote"; fromSec: number; toSec: number }>>();
    const place = (side: "room" | "remote", span: SeatSpan): string | undefined => {
        const row = personOf(span.name);
        if (!row) {
            return span.name;
        }

        const fromSec = span.fromSec ?? 0;
        const toSec = span.toSec ?? Infinity;
        const prior = held.get(row.key) ?? [];
        if (prior.some((other) => other.side === side && other.fromSec <= fromSec && toSec <= other.toSec)) {
            return undefined;
        }

        if (prior.some((other) => other.fromSec < toSec && other.toSec > fromSec)) {
            return span.name;
        }

        held.set(row.key, [...prior, { side, fromSec, toSec }]);
        return nameKey(span.name) === nameKey(row.name) ? span.name : row.name;
    };
    return {
        ...seats,
        room: seats.room.flatMap((row) => {
            const name = place("room", seatSpan(row));
            return name === undefined ? [] : [typeof row === "string" ? name : { ...row, name }];
        }),
        remote: seats.remote.flatMap((row) => {
            const name = place("remote", row);
            return name === undefined ? [] : [{ ...row, name }];
        }),
    };
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
