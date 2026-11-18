import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { readVoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Seat } from "./sound";

export const VOICE_PASS_HISTORY = "suggest findings and questions with voice naming";

export function voiceReadiness(record: MeetingRecord, { seatsHint = true } = {}) {
    const room = record.seats?.room ?? [];
    const remote = record.seats?.remote.map((seat) => seat.name) ?? [];
    const seats = room.length + remote.length > 0;
    const attended = [
        ...room,
        ...remote,
        ...(record.attendance?.people
            .filter((stay) => stay.toSec > Math.max(0, stay.fromSec))
            .map((stay) => stay.name) ?? []),
        ...record.participants
            .filter((person) => {
                if (person.self || person.firstSeenSec !== undefined || person.stays?.length) {
                    return true;
                }
                // Older records may only have the source's participants. A calendar invitation alone is not attendance.
                return !record.attendance && (!person.from.length || person.from.some((from) => from !== "calendar"));
            })
            .map((person) => person.name),
    ].filter((name, index, names) => names.findIndex((known) => sameName(known, name)) === index);
    const enrolled = Object.entries(record.project ? readVoiceStore(record.project).people : {});
    const occupied = new Set<Seat>();
    const covered = new Set<Seat>();
    const people = Object.fromEntries(
        attended.map((name) => {
            const prints = enrolled.filter(([person]) => sameName(person, name)).flatMap(([, value]) => value.samples);
            if (seats) {
                const ownMic = record.participants.some((person) => person.self && sameName(person.name, name));
                const seat =
                    room.some((person) => sameName(person, name)) ||
                    (ownMic && !remote.some((person) => sameName(person, name)))
                        ? "mic"
                        : "call";
                occupied.add(seat);
                if (prints.some((sample) => sample.seat === seat)) {
                    covered.add(seat);
                }
            }
            return [name, prints.length] as const;
        })
    );
    const samples = Object.values(people).reduce((sum, count) => sum + count, 0);
    const ready = seats && occupied.size > 0 && covered.size === occupied.size;
    const hints: string[] = [];
    if (!seats && seatsHint) {
        hints.push(toolCommand("meetings seats", record.id, "--apply"));
    }
    if (!record.project) {
        hints.push(toolCommand("meetings set", record.id, "--project", "<name>"));
    } else if (!samples || (seats && !ready)) {
        hints.push(toolCommand("meetings voices backfill", "--project", record.project));
    } else if (
        ready &&
        !record.items.some((item) => item.rules.includes(MeetingRule.VoiceEmbedding)) &&
        !record.history.some((event) => event.command === "suggest" && event.change === VOICE_PASS_HISTORY)
    ) {
        hints.push(toolCommand("meetings voices preview", record.id));
    }
    return { seats, samples, people, ready, hints };
}
