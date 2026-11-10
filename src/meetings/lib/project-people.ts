import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { type PairedBy, type PersonRef, samePerson, withoutSelf } from "@genesiscz/utils/meetings/people";
import { peopleOfMeeting } from "@genesiscz/utils/meetings/people-directory";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";

const { log } = logger.scoped("meetings-project-people");

/** A person the project's meetings name who is not paired with the project yet. */
export interface ProjectMeetingPerson {
    name: string;
    email?: string;
    /** How many of the project's meetings name them. */
    meetings: number;
    /** The newest of those meetings. */
    last: { id: string; title: string; start: string };
}

interface Found extends ProjectMeetingPerson {
    /** The newest meeting's record, for the pairing's source. */
    record: MeetingRecord;
}

function found(options: { records: MeetingRecord[]; config: MeetingsConfig; project: string }): Found[] {
    const paired = options.config.projects[options.project]?.match?.people ?? [];
    // The owner is marked in some meetings only (a participant or attendee with `self`); a named speaker carries no
    // mark, so the owner's name from any meeting is left out everywhere.
    const selves = options.records.flatMap((record) =>
        [...record.participants, ...(record.attendance?.people ?? []), ...(record.calendar?.people ?? [])]
            .filter((person) => person.self)
            .map((person) => ({ name: person.name }))
    );
    const people: Found[] = [];
    const ofProject = options.records
        .filter((record) => record.project === options.project)
        .sort((a, b) => a.start.localeCompare(b.start));

    for (const record of ofProject) {
        // The owner and anyone with the owner's name are never paired: the owner is in every meeting.
        for (const person of withoutSelf(peopleOfMeeting(record, { calendar: true }))) {
            if (paired.some((known) => samePerson(known, person)) || selves.some((self) => samePerson(self, person))) {
                continue;
            }

            const known = people.find((other) => samePerson(other, person));
            const last = { id: record.id, title: record.title, start: record.start };

            if (!known) {
                people.push({
                    name: person.name,
                    ...(person.email ? { email: person.email } : {}),
                    meetings: 1,
                    last,
                    record,
                });
                continue;
            }

            known.meetings += 1;
            known.last = last;
            known.record = record;

            if (!known.email && person.email) {
                known.email = person.email;
            }
        }
    }

    return people.sort(
        (a, b) => b.meetings - a.meetings || b.last.start.localeCompare(a.last.start) || a.name.localeCompare(b.name)
    );
}

/**
 * The people of the meetings that have `project` (each meeting's participants, attendance, linked calendar entry and
 * named speakers) who are not paired with it yet, most frequent first. Reads only.
 */
export function projectMeetingPeople(options: {
    records: MeetingRecord[];
    config: MeetingsConfig;
    project: string;
}): ProjectMeetingPerson[] {
    return found(options).map(({ record: _record, ...person }) => person);
}

/**
 * Where a pairing made from a meeting came from. A person on the meeting's linked calendar entry is paired through that
 * entry, as an answered project question pairs it, so "Unpair every person this entry paired" covers them too. A person
 * the meeting names otherwise (attendance, a named speaker) is paired by hand, with the meeting in the note.
 */
export function meetingPairingSource(record: MeetingRecord, person: PersonRef, at: string): PairedBy {
    const calendar = record.calendar;
    const onEntry =
        calendar?.eventId !== undefined &&
        [...(calendar.people ?? []), ...calendar.attendees.map((name) => ({ name }))].some((attendee) =>
            samePerson(attendee, person)
        );

    if (calendar?.eventId && onEntry) {
        return {
            kind: "calendar",
            from: calendar.from,
            entryId: calendar.eventId,
            ...(calendar.calendar ? { calendar: calendar.calendar } : {}),
            ...(calendar.title ? { title: calendar.title } : {}),
            ...(calendar.start ? { start: calendar.start } : {}),
            meetingId: record.id,
            at,
        };
    }

    const day = record.start.slice(0, 10);
    return { kind: "manual", at, note: `from the meeting “${record.title || "Untitled meeting"}” on ${day}` };
}

export interface PairedFromMeetings {
    project: string;
    paired: Array<{ name: string; email?: string; by: PairedBy }>;
}

/**
 * Pairs people of the project's meetings with the project: `people` names them, none pairs every person the project's
 * meetings name who is not paired yet. Each pairing names its source (`meetingPairingSource`). A person nobody
 * paired yet is the only one changed; an unknown project is refused.
 */
export async function pairFromMeetings(options: {
    records: MeetingRecord[];
    config: MeetingsConfigStore;
    project: string;
    people?: PersonRef[];
    now: Date;
}): Promise<PairedFromMeetings> {
    const config = await options.config.read();

    if (!config.projects[options.project]) {
        throw new Error(
            `No project ${options.project}. The known ones: ${Object.keys(config.projects).join(", ") || "none"}`
        );
    }

    const at = options.now.toISOString();
    const wanted = options.people;
    const chosen = found({ records: options.records, config, project: options.project }).filter(
        (person) => !wanted || wanted.some((one) => samePerson(one, person))
    );
    const paired: PairedFromMeetings["paired"] = [];

    // One write per source: the people of one calendar entry land together.
    const bySource = new Map<string, { by: PairedBy; people: PersonRef[] }>();

    for (const person of chosen) {
        const ref: PersonRef = { name: person.name, ...(person.email ? { email: person.email } : {}) };
        const by = meetingPairingSource(person.record, ref, at);
        const key = by.kind === "calendar" ? `calendar:${by.from}:${by.entryId}` : `manual:${by.note ?? ""}`;
        const group = bySource.get(key) ?? { by, people: [] };
        group.people.push(ref);
        bySource.set(key, group);
        paired.push({ ...ref, by });
    }

    for (const group of bySource.values()) {
        await options.config.pairPeople({ project: options.project, people: group.people, by: group.by });
    }

    log.debug({ project: options.project, paired: paired.length, writes: bySource.size }, "paired from meetings");
    return { project: options.project, paired };
}
