import type { MeetingParticipant, MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { IdentifiedDeparture } from "./departure";

type Stay = NonNullable<MeetingParticipant["stays"]>[number];

/** Consumes resolved identities. Later observed speech vetoes the inferred departure. */
export function personStays(options: {
    record: MeetingRecord;
    durationSec: number;
    lines?: readonly LineEvidence[];
    departures?: readonly IdentifiedDeparture[];
    silenceMinutes?: number;
    callSilent?: readonly { fromSec: number; toSec: number }[];
}): Array<{ name: string; self?: boolean; stays: Stay[] }> {
    return options.record.participants.map((person) => {
        const attendance = options.record.attendance?.people.filter((stay) => sameName(stay.name, person.name));
        const stays: Stay[] =
            person.stays?.map((stay) =>
                options.lines && (stay.source === "goodbye" || stay.source === "silence")
                    ? { fromSec: stay.fromSec, source: "platform-roster" as const, confidence: 1 }
                    : { ...stay }
            ) ??
            (attendance?.length
                ? attendance.map((stay) => ({
                      fromSec: stay.fromSec,
                      toSec: stay.toSec,
                      source: "attendance" as const,
                      confidence: 1,
                  }))
                : person.firstSeenSec === undefined
                  ? []
                  : [{ fromSec: person.firstSeenSec, source: "platform-roster", confidence: 1 }]);
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
            const laterVoice = options.lines?.some((line) => {
                const voice = options.record.evidence?.voice?.lines[String(line.index)];
                return (
                    line.startSec > event.atSec + 5 &&
                    voice?.quality === "matched" &&
                    voice.person &&
                    sameName(voice.person, person.name)
                );
            });
            if (later || confirmed || laterVoice) {
                continue;
            }
            const stay = stays.findLast((one) => one.fromSec <= event.atSec && one.toSec === undefined);
            if (stay) {
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
            const stay = stays.findLast((one) => one.toSec === undefined);
            const quiet =
                last &&
                options.callSilent.find(
                    (span) =>
                        span.fromSec <= last.endSec + 5 && span.toSec >= last.endSec + options.silenceMinutes! * 60
                );
            const laterVoice =
                last &&
                options.record.items.some(
                    (item) =>
                        item.kind === "speaker-range" &&
                        item.status === "confirmed" &&
                        item.speaker &&
                        sameName(item.speaker, person.name) &&
                        item.toSec > last.endSec + 5
                );
            if (
                last &&
                stay &&
                quiet &&
                !laterVoice &&
                options.durationSec - last.endSec >= options.silenceMinutes * 60
            ) {
                stay.toSec = last.endSec;
                stay.source = "silence";
                stay.confidence = 0.5;
            }
        }
        return { name: person.name, self: person.self, stays };
    });
}

export function rosterPresence(record: MeetingRecord, durationSec: number): Presence[] {
    return personStays({ record, durationSec }).flatMap((person) =>
        person.stays.map((stay) => ({
            name: person.name,
            self: person.self,
            fromSec: stay.fromSec,
            toSec: stay.toSec ?? durationSec,
        }))
    );
}
