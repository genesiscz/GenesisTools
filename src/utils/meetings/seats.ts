import { sha256Json } from "@genesiscz/utils/hash";
import { z } from "zod";
import { nameKey } from "./people";

const name = z.string().trim().min(1);

export const personDetailsSchema = z.object({
    role: name.optional(),
    aliases: z.array(name).optional(),
});
export type PersonDetails = z.infer<typeof personDetailsSchema>;

export const remoteSeatSchema = z
    .object({
        name,
        label: name.optional(),
        fromSec: z.number().finite().nonnegative().optional(),
        toSec: z.number().finite().nonnegative().optional(),
    })
    .refine((seat) => seat.toSec === undefined || seat.toSec >= (seat.fromSec ?? 0), {
        message: "a seat's leave time must be at or after its join time",
    });
export type RemoteSeat = z.infer<typeof remoteSeatSchema>;

export const microphoneGroupSchema = z.object({
    id: name,
    label: name.optional(),
    people: z.array(name).min(1),
    deviceId: name.optional(),
});
export type MicrophoneGroup = z.infer<typeof microphoneGroupSchema>;

/** A device group belongs entirely to room or remote seats. id self names the owner's microphone; deviceId identifies its owner. */
export const meetingSeatsSchema = z
    .object({
        room: z.array(name).default([]),
        remote: z
            .array(z.union([name.transform((value): RemoteSeat => ({ name: value })), remoteSeatSchema]))
            .default([]),
        microphones: z.array(microphoneGroupSchema).optional(),
    })
    .superRefine((seats, ctx) => {
        const room = new Set(seats.room.map(nameKey));
        const remote = new Set<string>();

        for (const [index, seat] of seats.remote.entries()) {
            const key = nameKey(seat.name);

            if (room.has(key) || remote.has(key)) {
                ctx.addIssue({ code: "custom", path: ["remote", index], message: "a person has one seat" });
            }

            remote.add(key);
        }

        if (room.size !== seats.room.length) {
            ctx.addIssue({ code: "custom", path: ["room"], message: "room people must be distinct" });
        }

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
export type MeetingSeats = z.infer<typeof meetingSeatsSchema>;

export function activeSeatPeople(options: { seats: MeetingSeats; atSec: number }): {
    room: string[];
    remote: RemoteSeat[];
} {
    return {
        room: [...options.seats.room],
        remote: options.seats.remote.filter(
            (seat) => options.atSec >= (seat.fromSec ?? 0) && (seat.toSec === undefined || options.atSec < seat.toSec)
        ),
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
    return raw === undefined ? undefined : meetingSeatsSchema.parse(raw);
}

/** Which seats a plan read: equal fingerprints mean the same room, remote people, their times and microphone groups. */
export function seatsFingerprint(seats: MeetingSeats | undefined): string {
    return sha256Json(seats ?? null).slice(0, 16);
}
