import type { MeetingParticipant, MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { IdentifiedDeparture } from "./departure";

type Stay = NonNullable<MeetingParticipant["stays"]>[number];

/** A stay a person's presence starts from; `inexactEnd` when the platform did not record the leave exactly. */
interface BaselineStay {
    stay: Stay;
    inexactEnd?: boolean;
}

/**
 * The stays a person's presence starts from, one rule for every reader (the stored stays, the opened meeting's
 * presence, the answers a question offers): their hand-corrected stays, else the platform's attendance, else their
 * stored stays, else from when the roster first saw them. Undefined when the record knows nothing of them.
 */
function baselineStays(record: MeetingRecord, name: string): BaselineStay[] | undefined {
    const person = record.participants.find((one) => sameName(one.name, name));
    const attendance = record.attendance?.people.filter((stay) => sameName(stay.name, name));

    if (attendance?.length && !person?.stays?.some((stay) => stay.source === "hand")) {
        return attendance.flatMap((stay) =>
            stay.toSec <= 0
                ? []
                : [
                      {
                          stay: {
                              fromSec: Math.max(0, stay.fromSec),
                              toSec: stay.toSec,
                              source: "attendance" as const,
                              confidence: 1,
                          },
                          ...(stay.leftAtExact === false ? { inexactEnd: true } : {}),
                      },
                  ]
        );
    }

    if (person?.stays) {
        return person.stays.map((stay) => ({ stay }));
    }

    return person?.firstSeenSec === undefined
        ? undefined
        : [{ stay: { fromSec: person.firstSeenSec, source: "platform-roster", confidence: 1 } }];
}

/**
 * A person's stays. `inexactEnds` holds the stays (by identity) that still end where the platform bounded an
 * attendance leave it did not record exactly; an inferred departure that ends one earlier takes it out. It is not
 * stored with the stays.
 */
export interface PersonStays {
    name: string;
    self?: boolean;
    stays: Stay[];
    inexactEnds?: ReadonlySet<Stay>;
}

/** Whether the record's stays put a person in the call at a time; true when it knows nothing of them. */
export function storedPresentAt(record: MeetingRecord, name: string, sec: number): boolean {
    const stays = baselineStays(record, name);
    return (
        stays === undefined ||
        stays.some(({ stay }) => sec >= stay.fromSec && (stay.toSec === undefined || sec < stay.toSec))
    );
}

/** Consumes resolved identities. Later observed speech vetoes the inferred departure. */
export function personStays(options: {
    record: MeetingRecord;
    durationSec: number;
    lines?: readonly LineEvidence[];
    departures?: readonly IdentifiedDeparture[];
    silenceMinutes?: number;
    callSilent?: readonly { fromSec: number; toSec: number }[];
}): PersonStays[] {
    return options.record.participants.map((person) => {
        const baseline = baselineStays(options.record, person.name) ?? [];
        const stays: Stay[] = baseline.map(({ stay }) =>
            options.lines && (stay.source === "goodbye" || stay.source === "silence")
                ? { fromSec: stay.fromSec, source: "platform-roster" as const, confidence: 1 }
                : { ...stay }
        );
        // An open stay, or one whose end the platform only bounded (`leftAtExact: false`), may end at an inferred
        // departure before that bound; an exact attendance leave stays as recorded.
        const inexact = new Set(stays.filter((_, index) => baseline[index]?.inexactEnd));
        const endable = (stay: Stay, atSec: number) =>
            stay.fromSec <= atSec && (stay.toSec === undefined || (inexact.has(stay) && atSec < stay.toSec));
        const laterMatchedVoice = (afterSec: number) =>
            options.lines?.some((line) => {
                const voice = options.record.evidence?.voice?.lines[String(line.index)];
                return (
                    line.startSec > afterSec &&
                    voice?.quality === "matched" &&
                    voice.person &&
                    sameName(voice.person, person.name)
                );
            }) ?? false;
        for (const event of options.departures ?? []) {
            if (!sameName(event.name, person.name)) {
                continue;
            }
            const later = options.lines?.some(
                (line) =>
                    line.startSec > event.atSec + 5 &&
                    !line.speakingUnknown &&
                    Object.keys(line.speaking).some((name) => sameName(name, person.name))
            );
            const confirmed = options.record.items.some(
                (item) =>
                    item.kind === "speaker-range" &&
                    item.status === "confirmed" &&
                    item.speaker &&
                    sameName(item.speaker, person.name) &&
                    item.toSec > event.atSec + 5
            );
            if (later || confirmed || laterMatchedVoice(event.atSec + 5)) {
                continue;
            }
            const stay = stays.findLast((one) => endable(one, event.atSec));
            if (stay) {
                inexact.delete(stay);
                stay.toSec = event.atSec;
                stay.source = "goodbye";
                stay.confidence = event.reason === "attendance" ? 1 : 0.8;
            }
        }
        if (options.silenceMinutes && options.callSilent?.length && !person.self) {
            const spoken =
                options.lines?.filter(
                    (line) =>
                        !line.speakingUnknown && Object.keys(line.speaking).some((name) => sameName(name, person.name))
                ) ?? [];
            const last = spoken.at(-1);
            const stay = last && stays.findLast((one) => endable(one, last.endSec));
            const quiet =
                last &&
                options.callSilent.find(
                    (span) =>
                        span.fromSec <= last.endSec + 5 && span.toSec >= last.endSec + options.silenceMinutes! * 60
                );
            // The same vetoes as an explicit departure: a later confirmed range or a later matched voice of theirs.
            const laterVoice =
                last &&
                (options.record.items.some(
                    (item) =>
                        item.kind === "speaker-range" &&
                        item.status === "confirmed" &&
                        item.speaker &&
                        sameName(item.speaker, person.name) &&
                        item.toSec > last.endSec + 5
                ) ||
                    laterMatchedVoice(last.endSec + 5));
            if (
                last &&
                stay &&
                quiet &&
                !laterVoice &&
                options.durationSec - last.endSec >= options.silenceMinutes * 60
            ) {
                inexact.delete(stay);
                stay.toSec = last.endSec;
                stay.source = "silence";
                stay.confidence = 0.5;
            }
        }
        return { name: person.name, self: person.self, stays, ...(inexact.size > 0 ? { inexactEnds: inexact } : {}) };
    });
}

export function rosterPresence(record: MeetingRecord, durationSec: number): Presence[] {
    return personStays({ record, durationSec }).flatMap((person) =>
        person.stays.map((stay) => presenceOf(person, stay, durationSec))
    );
}

/**
 * One stay as presence. A stay with no end runs to `durationSec`, an artificial bound, and a stay that still ends at
 * the platform's inexact leave (`inexactEnds`) ends at a bound too: both are marked `leftAtExact: false`, so a
 * departure resolver does not read that bound as a recorded leave.
 */
export function presenceOf(
    person: { name: string; self?: boolean; inexactEnds?: ReadonlySet<Stay> },
    stay: Stay,
    durationSec: number
): Presence {
    return {
        name: person.name,
        self: person.self,
        fromSec: stay.fromSec,
        toSec: stay.toSec ?? durationSec,
        ...(stay.toSec === undefined || person.inexactEnds?.has(stay) ? { leftAtExact: false } : {}),
    };
}
