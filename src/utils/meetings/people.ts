import { z } from "zod";

const isoTime = z.string().min(1);

/**
 * Where one pairing of a person with a project came from. A person keeps one entry per source, and unpairing a source
 * removes only that entry: the person leaves the project when no entry is left.
 */
export const pairedBySchema = z.discriminatedUnion("kind", [
    /** The owner confirmed this calendar entry for a meeting of the project, so its attendees belong to the project. */
    z.object({
        kind: z.literal("calendar"),
        /** The calendar that holds the entry: "apple-calendar", or the id of a source with its own calendar. */
        from: z.string().min(1),
        entryId: z.string().min(1),
        calendar: z.string().optional(),
        title: z.string().optional(),
        start: isoTime.optional(),
        /** The meeting whose answer confirmed the entry. */
        meetingId: z.string().optional(),
        at: isoTime,
    }),
    /** Paired by hand (`tools meetings projects pair`). */
    z.object({ kind: z.literal("manual"), at: isoTime, note: z.string().optional() }),
]);
export type PairedBy = z.infer<typeof pairedBySchema>;

export const pairedPersonSchema = z.object({
    name: z.string().trim().min(1),
    email: z.string().trim().min(1).optional(),
    pairedBy: z.array(pairedBySchema).min(1),
});
export type PairedPerson = z.infer<typeof pairedPersonSchema>;

/** A person as a calendar or a transcript names them. */
export interface PersonRef {
    name: string;
    email?: string;
    /** The owner: never paired with a project, since the owner is in every meeting. */
    self?: boolean;
}

/** Name tokens without accents, case, dots or a bracketed suffix: "Nováková Jana (XY)" and "jana.novakova" are one key. */
export function nameKey(name: string): string {
    return name
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .split(/[\s._,-]+/)
        .filter((token) => token.length > 0)
        .sort()
        .join(" ");
}

/** The same person: the same email, or, when either has no email, the same name tokens. */
export function samePerson(a: PersonRef, b: PersonRef): boolean {
    if (a.email && b.email) {
        return a.email.toLowerCase() === b.email.toLowerCase();
    }

    const key = nameKey(a.name);
    return key !== "" && key === nameKey(b.name);
}

function sameSource(a: PairedBy, b: PairedBy): boolean {
    if (a.kind === "manual" || b.kind === "manual") {
        return a.kind === b.kind;
    }

    return a.from === b.from && a.entryId === b.entryId;
}

/** Drops the owner and anyone with the owner's name ("Nováková Jana (XY)" beside the owner's "Jana Nováková"). */
export function withoutSelf(people: PersonRef[]): PersonRef[] {
    const selves = people.filter((person) => person.self);
    return people.filter((person) => !person.self && !selves.some((self) => samePerson(self, person)));
}

/**
 * Pairs each person with the project's list through `by`. A known person gains the source (once) and an email they
 * did not have; a new one joins. The owner is never paired. Returns a new list.
 */
export function addPairings(list: PairedPerson[], people: PersonRef[], by: PairedBy): PairedPerson[] {
    const next = list.map((person) => ({ ...person, pairedBy: [...person.pairedBy] }));

    for (const person of withoutSelf(people)) {
        const known = next.find((existing) => samePerson(existing, person));

        if (!known) {
            next.push({ name: person.name, ...(person.email ? { email: person.email } : {}), pairedBy: [by] });
            continue;
        }

        known.email ??= person.email;

        if (!known.pairedBy.some((existing) => sameSource(existing, by))) {
            known.pairedBy.push(by);
        }
    }

    return next;
}

export interface UnpairResult {
    people: PairedPerson[];
    /** Each person who lost a source, and whether they left the list (no other source pairs them). */
    removed: Array<{ name: string; email?: string; left: boolean }>;
}

/** Removes the pairings that came from one calendar entry; a person stays while another source still pairs them. */
export function removeEntryPairings(list: PairedPerson[], entryId: string): UnpairResult {
    const removed: UnpairResult["removed"] = [];
    const people: PairedPerson[] = [];

    for (const person of list) {
        const kept = person.pairedBy.filter((by) => by.kind !== "calendar" || by.entryId !== entryId);

        if (kept.length === person.pairedBy.length) {
            people.push(person);
            continue;
        }

        removed.push({ name: person.name, ...(person.email ? { email: person.email } : {}), left: kept.length === 0 });

        if (kept.length > 0) {
            people.push({ ...person, pairedBy: kept });
        }
    }

    return { people, removed };
}

/** The paired people of a list who are among `attendees`. */
export function pairedAmong(list: PairedPerson[], attendees: PersonRef[]): PairedPerson[] {
    const present = withoutSelf(attendees);
    return list.filter((person) => present.some((attendee) => samePerson(person, attendee)));
}
