import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { storedPresentAt } from "./person-stays";

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
        const tokens = nameTokens(name);
        const positions = tokens.filter((token) => token.length > 2).map((token) => folded.indexOf(` ${token} `));
        return positions.length > 0 && positions.every((at) => at >= 0)
            ? [{ name, at: Math.min(...positions), tokens }]
            : [];
    });
    if (options.self && /\b(me|myself|ja)\b/.test(folded)) {
        matches.push({
            name: options.self,
            at: Math.max(0, folded.search(/\b(me|myself|ja)\b/)),
            tokens: [...SELF_WORDS],
        });
    }
    const people = [...new Set(matches.sort((a, b) => a.at - b.at).map((match) => match.name))];
    if (people.length === 1 && /\b(then|potom|pak|second|druha|druhy|druhe)\b/.test(folded)) {
        return { kind: "comment", text };
    }
    // Only names joined into a list identify: any other word ("not", "whether", "cannot tell") keeps the prose a
    // comment, so a mention of a name never confirms a speaker.
    const named = new Set(matches.flatMap((match) => match.tokens));
    const rest = folded
        .trim()
        .split(" ")
        .filter((word) => word && !named.has(word) && !ANSWER_GLUE.has(word));
    return people.length > 0 && rest.length === 0 ? { kind: "people", people } : { kind: "comment", text };
}

/** The user's own words for themselves, which name `self` in a person answer. */
const SELF_WORDS = new Set(["me", "myself", "ja"]);

/** The words a person answer may hold besides the names: list joins, order words and an affirming lead-in. */
const ANSWER_GLUE = new Set([
    ...["and", "a", "i", "plus", "with", "s", "se", "then", "potom", "pak", "first", "second", "nejdriv", "druha"],
    ...["druhy", "druhe", "it", "is", "was", "that", "this", "to", "je", "byl", "byla"],
]);

/** A name's words, folded for matching, without a parenthesised note. */
function nameTokens(name: string): string[] {
    return (
        name
            .replace(/\([^)]*\)/g, "")
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? []
    );
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

/**
 * Whether a person was in the call at a time, by the same stays every other reader starts from (`storedPresentAt`):
 * hand-corrected stays win over imported attendance, so the choices and the parsed answers agree with the presence.
 */
export function personPresent(record: MeetingRecord, name: string, sec: number): boolean {
    return storedPresentAt(record, name, sec);
}
