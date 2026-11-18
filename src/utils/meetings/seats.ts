import { sha256Json } from "@genesiscz/utils/hash";
import { z } from "zod";
import { nameKey } from "./people";

const name = z.string().trim().min(1);

export const personDetailsSchema = z.object({
    role: name.optional(),
    aliases: z.array(name).optional(),
});
export type PersonDetails = z.infer<typeof personDetailsSchema>;

const seatSpanSchema = z.object({
    name,
    fromSec: z.number().finite().nonnegative().optional(),
    toSec: z.number().finite().nonnegative().optional(),
});
export type SeatSpan = z.infer<typeof seatSpanSchema>;
const positiveDuration = (seat: SeatSpan) => seat.toSec === undefined || seat.toSec > (seat.fromSec ?? 0);
const durationMessage = "a seat's leave time must be after its join time";
export const roomSeatSchema = z.union([name, seatSpanSchema.refine(positiveDuration, durationMessage)]);
const remoteRow = z.object({
    name,
    label: name.optional(),
    fromSec: seatSpanSchema.shape.fromSec,
    toSec: seatSpanSchema.shape.toSec,
});
export const remoteSeatSchema = remoteRow.refine(positiveDuration, durationMessage);
export type RemoteSeat = z.infer<typeof remoteSeatSchema>;

export function seatSpan(row: string | SeatSpan): SeatSpan {
    return typeof row === "string" ? { name: row } : row;
}

export const microphoneGroupSchema = z.object({
    id: name,
    label: name.optional(),
    people: z.array(name).min(1),
    deviceId: name.optional(),
});
export type MicrophoneGroup = z.infer<typeof microphoneGroupSchema>;

/** A device group belongs entirely to room or remote seats. id self names the owner's microphone; deviceId identifies its owner. */
export const storedMeetingSeatsSchema = z
    .object({
        room: z.array(roomSeatSchema).default([]),
        remote: z.array(z.union([name.transform((value): RemoteSeat => ({ name: value })), remoteRow])).default([]),
        microphones: z.array(microphoneGroupSchema).optional(),
    })
    .superRefine((seats, ctx) => {
        const byPerson = new Map<string, SeatSpan[]>();
        for (const side of ["room", "remote"] as const) {
            for (const [index, row] of seats[side].entries()) {
                const seat = seatSpan(row);
                const from = seat.fromSec ?? 0;
                const to = seat.toSec ?? Infinity;
                if (to < from) {
                    ctx.addIssue({ code: "custom", path: [side, index], message: durationMessage });
                }
                if (to <= from) {
                    continue;
                }
                const key = nameKey(seat.name);
                const prior = byPerson.get(key) ?? [];
                if (prior.some((other) => (other.fromSec ?? 0) < to && (other.toSec ?? Infinity) > from)) {
                    ctx.addIssue({ code: "custom", path: [side, index], message: "a person's seat intervals overlap" });
                }
                prior.push(seat);
                byPerson.set(key, prior);
            }
        }

        const room = new Set(seats.room.map((row) => nameKey(seatSpan(row).name)));
        const remote = new Set(seats.remote.map((row) => nameKey(row.name)));
        for (const [index, group] of (seats.microphones ?? []).entries()) {
            if (
                !group.people.every((person) => room.has(nameKey(person))) &&
                !group.people.every((person) => remote.has(nameKey(person)))
            ) {
                ctx.addIssue({
                    code: "custom",
                    path: ["microphones", index],
                    message: "microphone people must all be room people or all be remote people",
                });
            }
        }
    });
export type MeetingSeats = z.infer<typeof storedMeetingSeatsSchema>;
/** Old records may contain an empty remote stay. A newly supplied interval must have positive duration. */
export const meetingSeatsSchema = storedMeetingSeatsSchema.superRefine((seats, ctx) => {
    for (const [index, seat] of seats.remote.entries()) {
        if (!positiveDuration(seat)) {
            ctx.addIssue({ code: "custom", path: ["remote", index], message: durationMessage });
        }
    }
});

export function roomSeatNames(seats: MeetingSeats | undefined): string[] {
    const names = new Map<string, string>();
    for (const row of seats?.room ?? []) {
        const { name } = seatSpan(row);
        const key = nameKey(name);
        if (!names.has(key)) {
            names.set(key, name);
        }
    }
    return [...names.values()];
}

/** A meeting-wide exclusion can only use seats known to cover the entire meeting. */
export function wholeMeetingRoomPeople(seats: MeetingSeats | undefined): string[] {
    return (seats?.room ?? [])
        .map(seatSpan)
        .filter((seat) => !seat.fromSec && seat.toSec === undefined)
        .map((seat) => seat.name);
}

export function seatIntervalsFor(
    seats: MeetingSeats,
    person: string
): ReadonlyArray<{
    side: "mic" | "call";
    fromSec: number;
    toSec?: number;
}> {
    const key = nameKey(person);
    const intervals = [];
    for (const [rows, side] of [
        [seats.room, "mic"],
        [seats.remote, "call"],
    ] as const) {
        for (const row of rows) {
            const span = seatSpan(row);
            if (nameKey(span.name) === key && positiveDuration(span)) {
                intervals.push({
                    side,
                    fromSec: span.fromSec ?? 0,
                    ...(span.toSec === undefined ? {} : { toSec: span.toSec }),
                });
            }
        }
    }
    return intervals.sort((a, b) => a.fromSec - b.fromSec);
}

/** Custom device IDs can belong to either side. For a moving member, keep the explicitly mapped device's side. */
export function microphoneSide(seats: MeetingSeats, group: MicrophoneGroup): "room" | "remote" {
    if (group.id === "self") {
        return "room";
    }
    const remote = new Set(seats.remote.map((row) => nameKey(row.name)));
    return group.people.every((person) => remote.has(nameKey(person))) ? "remote" : "room";
}

export function activeSeatPeople(options: { seats: MeetingSeats; atSec: number }): {
    room: string[];
    remote: RemoteSeat[];
} {
    const active = (seat: SeatSpan) => options.atSec >= (seat.fromSec ?? 0) && options.atSec < (seat.toSec ?? Infinity);
    return {
        room: options.seats.room
            .map(seatSpan)
            .filter(active)
            .map((seat) => seat.name),
        remote: options.seats.remote.filter(active),
    };
}

/** Match explicit aliases only when they identify one person; an ambiguous alias stays unknown. */
export function personForAlias<T extends PersonDetails & { name: string }>(
    people: readonly T[],
    alias: string
): T | undefined {
    const key = nameKey(alias);
    const matches = people.filter((person) =>
        [person.name, ...(person.aliases ?? [])].some((value) => nameKey(value) === key)
    );
    return matches.length === 1 ? matches[0] : undefined;
}

/** Additive migration: old people keep unknown roles, and old remote strings become named seats. No I/O. */
export function migrateMeetingSeats(raw: unknown): MeetingSeats | undefined {
    return raw === undefined ? undefined : storedMeetingSeatsSchema.parse(raw);
}

/** Which seats a plan read: equal fingerprints mean the same room, remote people, their times and microphone groups. */
export function seatsFingerprint(seats: MeetingSeats | undefined): string {
    return sha256Json(seats ?? null).slice(0, 16);
}
