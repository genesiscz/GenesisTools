import { presenceSections, sameName } from "../transcribe/speakers";
import type { MeetingRecord, MeetingStore } from "./record";
import { activeSeatPeople } from "./seats";

export interface MeetingPersonEdit {
    name: string;
    action: "add" | "remove";
    fromSec?: number;
    toSec?: number;
    atMic?: boolean;
    via?: string;
}

/** Half-open attendance bounds apply to both room and remote device groups. */
export function microphoneCandidates(record: MeetingRecord, atSec: number, owner = "self"): string[] {
    if (!record.seats) {
        return [];
    }
    const active = activeSeatPeople({ seats: record.seats, atSec });
    const names = new Set([...active.room, ...active.remote.map((person) => person.name)]);
    const groups = record.seats.microphones ?? [];
    const group = groups.find((one) => one.id === owner || one.deviceId === owner);
    return (group?.people ?? (owner === "self" ? active.room : []))
        .filter((name) => names.has(name))
        .filter((name) => {
            const stays = record.attendance?.people.filter((stay) => sameName(stay.name, name));
            return !stays?.length || stays.some((stay) => atSec >= stay.fromSec && atSec < stay.toSec);
        });
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
            const atMic = edit.atMic ?? (!edit.via && next.seats?.room.some((person) => same(person)));
            const via =
                edit.via ??
                (edit.atMic === undefined && !atMic
                    ? next.seats?.microphones?.find((group) => group.people.some((person) => same(person)))?.deviceId
                    : undefined);
            const prior = next.participants.find((person) => same(person.name));
            const priorSeat = next.seats?.remote.find((person) => same(person.name));
            if (options.selfName && !same(options.selfName) && !next.participants.some((person) => person.self)) {
                next.participants.push({ name: options.selfName, self: true, from: ["source"] });
            }
            const endSec = meetingEndSec(next) ?? toSec;
            // A record without attendance shows its roster's stays; the first manual table starts from them, so one
            // edited person never hides everyone else.
            const table = next.attendance?.people ?? (endSec === undefined ? [] : rosterStays(next, endSec));
            next.participants = next.participants.filter((person) => !same(person.name));
            const stays = table.filter((person) => !same(person.name));
            const seats = next.seats ?? { room: [], remote: [] };
            seats.room = seats.room.filter((person) => !same(person));
            seats.remote = seats.remote.filter((person) => !same(person.name));
            seats.microphones = (seats.microphones ?? [])
                .map((group) => ({ ...group, people: group.people.filter((person) => !same(person)) }))
                .filter((group) => group.people.length);
            if (edit.action === "add") {
                next.participants.push({
                    ...prior,
                    name,
                    ...(prior?.self || (options.selfName && sameName(options.selfName, name)) ? { self: true } : {}),
                    from: [...new Set([...(prior?.from ?? []), "user"])],
                    firstSeenSec: Math.min(prior?.firstSeenSec ?? fromSec, fromSec),
                    stays: [{ fromSec, toSec: toSec!, source: "hand", confidence: 1 }],
                });
                stays.push({ name, fromSec, toSec: toSec!, joinedAtExact: true, leftAtExact: true });
                if (atMic) {
                    const self = next.participants.find((person) => person.self)?.name;
                    seats.room = [...new Set([...seats.room, ...(self ? [self] : []), name])];
                    const group = seats.microphones.find((one) => one.id === "self");
                    if (group) {
                        group.people = [...new Set([...group.people, ...(self ? [self] : []), name])];
                    } else {
                        seats.microphones.push({ id: "self", people: [...new Set([...(self ? [self] : []), name])] });
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
