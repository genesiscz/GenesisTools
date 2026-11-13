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
    const toSec = edit.toSec ?? (record.end ? (Date.parse(record.end) - Date.parse(record.start)) / 1000 : undefined);
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
            if (options.selfName && !next.participants.some((person) => person.self)) {
                next.participants.push({ name: options.selfName, self: true, from: ["source"] });
            }
            next.participants = next.participants.filter((person) => !same(person.name));
            const stays = (next.attendance?.people ?? []).filter((person) => !same(person.name));
            const seats = next.seats ?? { room: [], remote: [] };
            seats.room = seats.room.filter((person) => !same(person));
            seats.remote = seats.remote.filter((person) => !same(person.name));
            seats.microphones = (seats.microphones ?? [])
                .map((group) => ({ ...group, people: group.people.filter((person) => !same(person)) }))
                .filter((group) => group.people.length);
            if (edit.action === "add") {
                const prior = record.participants.find((person) => same(person.name));
                next.participants.push({
                    ...prior,
                    name,
                    from: [...new Set([...(prior?.from ?? []), "user"])],
                    firstSeenSec: Math.min(prior?.firstSeenSec ?? fromSec, fromSec),
                    stays: [{ fromSec, toSec: toSec!, source: "hand", confidence: 1 }],
                });
                stays.push({ name, fromSec, toSec: toSec!, joinedAtExact: true, leftAtExact: true });
                if (edit.atMic) {
                    const self = next.participants.find((person) => person.self)?.name;
                    seats.room = [...new Set([...seats.room, ...(self ? [self] : []), name])];
                    const group = seats.microphones.find((one) => one.id === "self");
                    if (group) {
                        group.people = [...new Set([...group.people, ...(self ? [self] : []), name])];
                    } else {
                        seats.microphones.push({ id: "self", people: [...new Set([...(self ? [self] : []), name])] });
                    }
                } else {
                    seats.remote.push({ name, fromSec, toSec: toSec! });
                    if (edit.via) {
                        const owner = edit.via.trim();
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
            next.attendance = { from: next.attendance?.from ?? "user", people: stays };
            next.sections = presenceSections(stays);
        }
    );
}
