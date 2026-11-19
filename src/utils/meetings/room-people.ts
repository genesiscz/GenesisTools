import { presenceSections, sameName } from "../transcribe/speakers";
import { nameKey } from "./people";
import type { MeetingRecord, MeetingStore } from "./record";
import { activeSeatPeople, type MeetingSeats, microphoneSide, type RemoteSeat, seatSpan } from "./seats";

export interface MeetingPersonEdit {
    name: string;
    action: "add" | "remove";
    fromSec?: number;
    toSec?: number;
    atMic?: boolean;
    via?: string;
}

/** Legacy remote rows with equal bounds carry no occupancy, including for the side of a device group. */
export function withoutEmptyRemoteSeats(seats: MeetingSeats | undefined): MeetingSeats | undefined {
    const empty = (seat: RemoteSeat) => seat.toSec !== undefined && seat.toSec <= (seat.fromSec ?? 0);
    if (!seats?.remote.some(empty)) {
        return seats;
    }
    const remote = seats.remote.filter((row) => !empty(row));
    const remoteNames = new Set(remote.map((row) => nameKey(row.name)));
    const roomNames = new Set(seats.room.map((row) => nameKey(seatSpan(row).name)));
    const microphones = seats.microphones?.flatMap((group) => {
        const seated = group.people.filter(
            (person) => roomNames.has(nameKey(person)) || remoteNames.has(nameKey(person))
        );
        const allInRoom = seated.every((person) => roomNames.has(nameKey(person)));
        const people =
            group.id === "self" || allInRoom ? seated : seated.filter((person) => remoteNames.has(nameKey(person)));
        return people.length ? [{ ...group, people }] : [];
    });
    return { ...seats, remote, ...(microphones ? { microphones } : {}) };
}

/** Only a saved group identifies an endpoint's human occupants. */
export function mappedMicrophone(seats: MeetingSeats | undefined, endpoint: string) {
    return seats?.microphones?.find(
        (group) => group.id === endpoint || (group.deviceId && nameKey(group.deviceId) === nameKey(endpoint))
    );
}

/** Occupants of the mapped microphone at this instant. Room occupancy is independent of call attendance. */
export function microphoneCandidates(record: MeetingRecord, atSec: number, owner = "self"): string[] {
    const seats = withoutEmptyRemoteSeats(record.seats);
    if (!seats) {
        return [];
    }
    const active = activeSeatPeople({ seats, atSec });
    const group = mappedMicrophone(seats, owner);
    if (!group) {
        return owner === "self" ? active.room : [];
    }
    const side = microphoneSide(seats, group);
    if (side === "remote" && group.deviceId) {
        const account = group.deviceId;
        const stays = record.attendance?.people.filter((stay) => sameName(stay.name, account));
        if (stays?.length && !stays.some((stay) => atSec >= stay.fromSec && atSec < stay.toSec)) {
            return [];
        }
    }
    const names = new Set((side === "room" ? active.room : active.remote.map((row) => row.name)).map(nameKey));
    return group.people.filter((name) => names.has(nameKey(name)));
}

type AttendanceStay = NonNullable<MeetingRecord["attendance"]>["people"][number];

/** The meeting's length in seconds, when its end is known. */
function meetingEndSec(record: MeetingRecord): number | undefined {
    return record.end ? (Date.parse(record.end) - Date.parse(record.start)) / 1000 : undefined;
}

/**
 * The presence a record without attendance shows, as `rosterPresence` reads it: each participant's own stays, else
 * one stay from the first time they were seen; an open stay runs to `endSec`.
 */
function rosterStays(record: MeetingRecord, endSec: number): AttendanceStay[] {
    return record.participants.flatMap((person) => {
        const stays: Array<{ fromSec: number; toSec?: number }> =
            person.stays ?? (person.firstSeenSec === undefined ? [] : [{ fromSec: person.firstSeenSec }]);
        return stays.flatMap((stay): AttendanceStay[] => {
            const toSec = stay.toSec ?? endSec;
            return toSec > stay.fromSec ? [{ name: person.name, fromSec: stay.fromSec, toSec }] : [];
        });
    });
}

export async function editMeetingPerson(options: {
    store: MeetingStore;
    meeting: string;
    edit: MeetingPersonEdit;
    selfName?: string;
}): Promise<MeetingRecord> {
    const { store, edit } = options;
    const name = edit.name.trim();
    const record = store.resolve(options.meeting);
    if (!record || !name) {
        throw new Error("A stored meeting and a nonempty person name are required.");
    }
    const fromSec = edit.fromSec ?? 0;
    const toSec = edit.toSec ?? meetingEndSec(record);
    if (
        edit.action === "add" &&
        (!Number.isFinite(fromSec) || fromSec < 0 || toSec === undefined || !Number.isFinite(toSec) || toSec <= fromSec)
    ) {
        throw new Error("Give a finite --to after --from, or a meeting with a known end.");
    }
    if (edit.atMic && edit.via) {
        throw new Error("Choose --at-mic or --via, not both.");
    }
    return store.update(
        record.id,
        { command: "attendance", change: `${edit.action} meeting person ${name}` },
        (next) => {
            const same = (value: string) => sameName(value, name);
            // An omitted placement is read from the record as it is under the lock: an edit that moved the person
            // while this one waited is kept.
            const seats: MeetingSeats = next.seats ?? { room: [], remote: [] };
            const inRoom = seats.room.some((row) => same(seatSpan(row).name));
            const atMic = edit.atMic ?? (!edit.via && inRoom);
            const via =
                edit.via ??
                (edit.atMic === undefined && !atMic
                    ? next.seats?.microphones?.find((group) => group.people.some((person) => same(person)))?.deviceId
                    : undefined);
            const prior = next.participants.find((person) => same(person.name));
            const priorSeat = next.seats?.remote.find((person) => same(person.name));
            // Attendance-only edits must not move a physical seat or collapse a rejoin. The native person
            // editor also sends the displayed placement when only its attendance clocks were edited.
            const currentDevice = seats.microphones?.find(
                (group) => microphoneSide(seats, group) === "remote" && group.people.some(same)
            )?.deviceId;
            const placementSpecified = edit.atMic !== undefined || edit.via !== undefined;
            const samePlacement =
                Boolean(inRoom || priorSeat) &&
                (!placementSpecified || (atMic ? inRoom : priorSeat && via === currentDevice));
            if (options.selfName && !same(options.selfName) && !next.participants.some((person) => person.self)) {
                next.participants.push({ name: options.selfName, self: true, from: ["source"] });
            }
            const endSec = meetingEndSec(next) ?? toSec;
            // A record without attendance shows its roster's stays; the first manual table starts from them, so one
            // edited person never hides everyone else.
            const table = next.attendance?.people ?? (endSec === undefined ? [] : rosterStays(next, endSec));
            next.participants = next.participants.filter((person) => !same(person.name));
            const stays = table.filter((person) => !same(person.name));
            if (edit.action === "remove" || !samePlacement) {
                // An explicit move replaces only this window. Keep both pieces of a seat it cuts through.
                const remaining = (row: RemoteSeat): RemoteSeat[] => {
                    if (edit.action === "remove") {
                        return [];
                    }
                    if ((row.toSec ?? Infinity) <= fromSec || (row.fromSec ?? 0) >= toSec!) {
                        return [row];
                    }
                    return [
                        ...((row.fromSec ?? 0) < fromSec ? [{ ...row, toSec: fromSec }] : []),
                        ...((row.toSec ?? Infinity) > toSec! ? [{ ...row, fromSec: toSec! }] : []),
                    ];
                };
                const groups = (seats.microphones ?? []).map((group) => ({
                    group,
                    side: microphoneSide(seats, group),
                }));
                seats.room = seats.room.flatMap((row): typeof seats.room =>
                    same(seatSpan(row).name) ? remaining(seatSpan(row)) : [row]
                );
                seats.remote = seats.remote.flatMap((row) => (same(row.name) ? remaining(row) : [row]));
                seats.microphones = groups
                    .map(({ group, side }) => {
                        const stillSeated = seats[side].some((row) => same(seatSpan(row).name));
                        return stillSeated
                            ? group
                            : { ...group, people: group.people.filter((member) => !same(member)) };
                    })
                    .filter((group) => group.people.length);
            }
            if (edit.action === "add") {
                next.participants.push({
                    ...prior,
                    name,
                    ...(prior?.self || (options.selfName && sameName(options.selfName, name)) ? { self: true } : {}),
                    from: [...new Set([...(prior?.from ?? []), "user"])],
                    firstSeenSec: Math.min(prior?.firstSeenSec ?? fromSec, fromSec),
                    stays: [{ fromSec, toSec: toSec!, source: "hand", leaveSource: "hand", confidence: 1 }],
                });
                stays.push({ name, fromSec, toSec: toSec!, joinedAtExact: true, leftAtExact: true });
            }
            if (edit.action === "add" && !samePlacement) {
                seats.microphones ??= [];
                if (atMic) {
                    const group = seats.microphones.find((one) => one.id === "self");
                    const self = !group ? next.participants.find((person) => person.self)?.name : undefined;
                    if (
                        self &&
                        !same(self) &&
                        !seats.room.some((row) => sameName(seatSpan(row).name, self)) &&
                        !seats.remote.some((row) => sameName(row.name, self))
                    ) {
                        seats.room.push(self);
                    }
                    seats.room.push({ name, fromSec, toSec: toSec! });
                    const members = [
                        ...(self && seats.room.some((row) => sameName(seatSpan(row).name, self)) ? [self] : []),
                        name,
                    ];
                    if (group) {
                        group.people = [...new Set([...group.people, ...members])];
                    } else {
                        seats.microphones.push({ id: "self", people: [...new Set(members)] });
                    }
                } else {
                    seats.remote.push({ ...priorSeat, name, fromSec, toSec: toSec! });
                    if (via) {
                        const owner = via.trim();
                        if (!owner) {
                            throw new Error("Device owner must be nonempty.");
                        }
                        if (!seats.remote.some((one) => sameName(one.name, owner))) {
                            seats.remote.push({ name: owner });
                        }
                        const group = seats.microphones.find((one) => one.deviceId === owner);
                        if (group) {
                            group.people = [...new Set([...group.people, owner, name])];
                        } else {
                            seats.microphones.push({
                                id: `device:${owner}`,
                                deviceId: owner,
                                people: [...new Set([owner, name])],
                            });
                        }
                    }
                }
            }
            next.seats = seats;
            // A removal from a record with no attendance and no known end has no table to write: an empty one would
            // hide everyone, while the roster without the person already leaves them out.
            if (next.attendance || endSec !== undefined || stays.length > 0) {
                next.attendance = { from: next.attendance?.from ?? "user", people: stays };
                next.sections = presenceSections(stays);
            }
        }
    );
}
