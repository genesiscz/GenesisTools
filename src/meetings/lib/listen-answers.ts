import type { MeetingRecord } from "@genesiscz/utils/meetings/record";

export function personKey(text: string): string {
    return text
        .replace(/\([^)]*\)/g, "")
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" ");
}

export type PersonAnswer = { kind: "people"; people: string[] } | { kind: "comment"; text: string };

export function parsePersonAnswer(options: { text: string; people: string[]; self?: string }): PersonAnswer {
    const text = options.text.trim();
    const seen = new Set<string>();
    const known = options.people.filter((name) => {
        const key = personKey(name);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    const exact = known.find((name) => personKey(name) === personKey(text));
    if (exact) {
        return { kind: "people", people: [exact] };
    }
    const folded = ` ${text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    const matches = known.flatMap((name) => {
        const tokens =
            name
                .replace(/\([^)]*\)/g, "")
                .normalize("NFD")
                .replace(/\p{M}/gu, "")
                .toLowerCase()
                .match(/[\p{L}\p{N}]+/gu) ?? [];
        const positions = tokens.filter((token) => token.length > 2).map((token) => folded.indexOf(` ${token} `));
        return positions.length > 0 && positions.every((at) => at >= 0) ? [{ name, at: Math.min(...positions) }] : [];
    });
    if (options.self && /\b(me|myself|ja)\b/.test(folded)) {
        matches.push({ name: options.self, at: Math.max(0, folded.search(/\b(me|myself|ja)\b/)) });
    }
    const people = [...new Set(matches.sort((a, b) => a.at - b.at).map((match) => match.name))];
    if (people.length === 1 && /\b(then|potom|pak|second|druha|druhy|druhe)\b/.test(folded)) {
        return { kind: "comment", text };
    }
    return people.length > 0 ? { kind: "people", people } : { kind: "comment", text };
}

export function recordPeople(record: MeetingRecord): string[] {
    return [
        ...new Set([
            ...record.participants.map((person) => person.name),
            ...(record.attendance?.people.map((person) => person.name) ?? []),
            ...Object.values(record.speakers.labels),
            ...record.items.flatMap((item) =>
                item.kind === "speaker-range" && item.status === "confirmed" && item.speaker ? [item.speaker] : []
            ),
        ]),
    ];
}

export interface VoiceSegment {
    fromWord: number;
    speaker: string;
}

export function sentenceSegments(text: string, people: string[]): VoiceSegment[] | undefined {
    const words = text.trim().split(/\s+/);
    const starts = [
        0,
        ...words.flatMap((word, index) => (/[.!?]["'”’)]*$/.test(word) && index + 1 < words.length ? [index + 1] : [])),
    ];
    if (starts.length < people.length) {
        return undefined;
    }
    return people.map((speaker, index) => ({ fromWord: starts[index]!, speaker }));
}

export function personPresent(record: MeetingRecord, name: string, sec: number): boolean {
    const attendance = record.attendance?.people.filter((stay) => personKey(stay.name) === personKey(name));
    if (attendance?.length) {
        return attendance.some((stay) => sec >= stay.fromSec && sec < stay.toSec);
    }
    const person = record.participants.find((one) => personKey(one.name) === personKey(name));
    if (person?.stays?.length) {
        return person.stays.some((stay) => sec >= stay.fromSec && (stay.toSec === undefined || sec < stay.toSec));
    }
    return person?.firstSeenSec === undefined || sec >= person.firstSeenSec;
}
